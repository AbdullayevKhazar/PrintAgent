import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STALE_PRINTING_MS = 120000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_PRINT_TIMEOUT_MS = 30000;

export function getPrintQueueConfig() {
  const disabled = isDisabledEnv("PRINT_QUEUE_ENABLED");
  const apiBaseUrl = stripTrailingSlash(readOptionalEnv("PRINT_API_BASE_URL"));
  const branchId = readOptionalEnv("PRINT_BRANCH_ID");
  const deviceId = readOptionalEnv("PRINT_DEVICE_ID");

  return {
    enabled: !disabled && Boolean(apiBaseUrl && branchId),
    disabled,
    apiBaseUrl,
    branchId,
    deviceId,
    pollIntervalMs: readNumberEnv(
      "PRINT_QUEUE_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
    ),
    maxAttempts: readNumberEnv("PRINT_QUEUE_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
    stalePrintingMs: readNumberEnv(
      "PRINT_QUEUE_STALE_PRINTING_MS",
      DEFAULT_STALE_PRINTING_MS,
    ),
    requestTimeoutMs: readNumberEnv(
      "PRINT_QUEUE_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    printTimeoutMs: readNumberEnv(
      "PRINT_AGENT_PRINT_TIMEOUT_MS",
      DEFAULT_PRINT_TIMEOUT_MS,
    ),
  };
}

export function startPrintQueueWorker(options = {}) {
  const worker = new PrintQueueWorker(options);
  worker.start();
  return worker;
}

class PrintQueueWorker {
  constructor({ bridgeUrl, onStatusChange } = {}) {
    this.bridgeUrl = stripTrailingSlash(
      bridgeUrl || "http://127.0.0.1:9191",
    );
    this.onStatusChange =
      typeof onStatusChange === "function" ? onStatusChange : null;
    this.config = getPrintQueueConfig();
    this.running = false;
    this.currentJobId = null;
    this.errorDelayMs = this.config.pollIntervalMs;
    this.statusKey = "";
  }

  start() {
    if (this.config.disabled) {
      this.setStatus("disabled", "Print queue disabled by env");
      return;
    }

    if (!this.config.apiBaseUrl || !this.config.branchId) {
      this.setStatus(
        "disabled",
        "Print queue disabled: PRINT_API_BASE_URL or PRINT_BRANCH_ID missing",
      );
      return;
    }

    if (this.running) {
      return;
    }

    this.running = true;
    this.setStatus("starting", "Print queue worker starting");
    this.loopPromise = this.runLoop();
  }

  stop() {
    this.running = false;
    this.setStatus("stopped", "Print queue worker stopped");
  }

  getStatus() {
    return {
      state: this.statusState || "unknown",
      message: this.statusMessage || "",
      jobId: this.currentJobId,
      branchId: this.config.branchId,
      deviceId: this.config.deviceId || null,
      apiBaseUrl: this.config.apiBaseUrl,
    };
  }

  async runLoop() {
    while (this.running) {
      try {
        await this.processOnce();
        this.errorDelayMs = this.config.pollIntervalMs;
        await delay(this.config.pollIntervalMs);
      } catch (error) {
        this.currentJobId = null;
        this.setStatus("error", `Print queue error: ${getErrorMessage(error)}`);
        this.errorDelayMs = Math.min(this.errorDelayMs * 2, 30000);
        await delay(this.errorDelayMs);
      }
    }
  }

  async processOnce() {
    const job = await this.claimNextJob();

    if (!job) {
      this.setStatus("idle", "Waiting for print jobs", {}, false);
      return;
    }

    await this.printClaimedJob(job);
  }

  async claimNextJob() {
    const { response, json, text } = await postJson(
      joinUrl(this.config.apiBaseUrl, "/print-jobs/claim"),
      {
        branchId: this.config.branchId,
        ...(this.config.deviceId ? { deviceId: this.config.deviceId } : {}),
        maxAttempts: this.config.maxAttempts,
        stalePrintingMs: this.config.stalePrintingMs,
      },
      this.config.requestTimeoutMs,
    );

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `claim failed: HTTP ${response.status} ${shortText(text)}`,
      );
    }

    return unwrapJob(json);
  }

  async printClaimedJob(job) {
    this.currentJobId = job.id;
    this.setStatus("printing", `Printing job ${job.id}`, {
      jobId: job.id,
      type: job.type,
    });

    try {
      const raw = getRawEscpos(job);

      if (!raw) {
        throw new Error(
          `Job ${job.id} does not contain raw ESC/POS data yet.`,
        );
      }

      await this.printRaw(job, raw);
    } catch (error) {
      await this.markFailed(job, error);
      this.currentJobId = null;
      this.setStatus("failed", `Job ${job.id} failed: ${getErrorMessage(error)}`);
      return;
    }

    const markedPrinted = await this.markPrintedUntilSuccessful(job);
    this.currentJobId = null;

    if (markedPrinted) {
      this.setStatus("printed", `Job ${job.id} printed`);
    }
  }

  async printRaw(job, raw) {
    const { response, text } = await postJson(
      joinUrl(this.bridgeUrl, "/print"),
      {
        ticketCode: job.id,
        branch: job.branchId || this.config.branchId,
        service: job.type || "print-job",
        createdAt: job.createdAt || new Date().toISOString(),
        message: "",
        adapter: "escpos",
        format: "raw",
        raw,
        cut: true,
      },
      this.config.printTimeoutMs,
    );

    if (!response.ok) {
      throw new Error(
        `local bridge print failed: HTTP ${response.status} ${shortText(text)}`,
      );
    }
  }

  async markPrintedUntilSuccessful(job) {
    while (this.running) {
      try {
        const { response, text } = await postJson(
          joinUrl(
            this.config.apiBaseUrl,
            `/print-jobs/${encodeURIComponent(job.id)}/printed`,
          ),
          {
            deviceId: this.config.deviceId || null,
            printedAt: new Date().toISOString(),
          },
          this.config.requestTimeoutMs,
        );

        if (response.ok) {
          return true;
        }

        this.setStatus(
          "warning",
          `Job ${job.id} printed locally, waiting to mark printed`,
          { status: response.status, body: shortText(text) },
        );
      } catch (error) {
        this.setStatus(
          "warning",
          `Job ${job.id} printed locally, backend mark retry pending`,
          { error: getErrorMessage(error) },
        );
      }

      await delay(this.config.pollIntervalMs);
    }

    return false;
  }

  async markFailed(job, error) {
    const errorMessage = getErrorMessage(error).slice(0, 1000);

    try {
      const { response, text } = await postJson(
        joinUrl(
          this.config.apiBaseUrl,
          `/print-jobs/${encodeURIComponent(job.id)}/failed`,
        ),
        {
          deviceId: this.config.deviceId || null,
          errorMessage,
        },
        this.config.requestTimeoutMs,
      );

      if (!response.ok) {
        console.error(
          `[print-queue] mark failed did not succeed: HTTP ${response.status} ${shortText(text)}`,
        );
      }
    } catch (markError) {
      console.error("[print-queue] mark failed request error", markError);
    }
  }

  setStatus(state, message, details = {}, log = true) {
    const nextKey = `${state}:${message}:${this.currentJobId || ""}`;

    this.statusState = state;
    this.statusMessage = message;

    if (log && nextKey !== this.statusKey) {
      this.statusKey = nextKey;
      const detailText = Object.keys(details).length
        ? ` ${JSON.stringify(details)}`
        : "";
      console.log(`[print-queue] ${message}${detailText}`);
    }

    this.onStatusChange?.(this.getStatus());
  }
}

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text().catch(() => "");
    const json = parseJson(text);

    return { response, text, json };
  } finally {
    clearTimeout(timeoutId);
  }
}

function unwrapJob(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload;
  const candidate = record.job ?? record.data ?? record.printJob ?? record;

  if (candidate && typeof candidate === "object" && typeof candidate.id === "string") {
    return candidate;
  }

  return null;
}

function getRawEscpos(job) {
  if (typeof job.raw === "string" && job.raw.length > 0) {
    return job.raw;
  }

  if (
    job.payload &&
    typeof job.payload === "object" &&
    typeof job.payload.raw === "string"
  ) {
    return job.payload.raw;
  }

  return "";
}

function parseJson(text) {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function joinUrl(baseUrl, path) {
  return `${stripTrailingSlash(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function shortText(value) {
  return String(value || "").trim().slice(0, 300);
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function readOptionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || "";
}

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isDisabledEnv(name) {
  const value = readOptionalEnv(name).toLowerCase();
  return value === "0" || value === "false" || value === "off";
}
