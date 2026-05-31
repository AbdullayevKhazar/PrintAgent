import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVICE_NAME = "nextcross-local-print-agent";
const DEFAULT_PORT = 9191;
const DEFAULT_RESPONSE_TIMEOUT_MS = 2500;
const DEFAULT_PRINT_TIMEOUT_MS = 20000;
const DEFAULT_RAW_ENCODING = "latin1";
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://testapp.nextcross.az",
  "https://app.nextcross.az",
];
const MAX_BODY_BYTES = 1024 * 1024;
const ESC_POS_CUT = "\x1D\x56\x00";

loadEnvFile(path.join(__dirname, ".env"));

const config = {
  port: readNumberEnv("PRINT_AGENT_PORT", readNumberEnv("PORT", DEFAULT_PORT)),
  host: readOptionalEnv("PRINT_AGENT_HOST") || "localhost",
  printerName:
    readOptionalEnv("PRINT_AGENT_PRINTER_NAME") ||
    readOptionalEnv("PRINTER_NAME"),
  rawEncoding:
    readOptionalEnv("PRINT_AGENT_RAW_ENCODING") || DEFAULT_RAW_ENCODING,
  responseTimeoutMs: readNumberEnv(
    "PRINT_AGENT_RESPONSE_TIMEOUT_MS",
    DEFAULT_RESPONSE_TIMEOUT_MS,
  ),
  printTimeoutMs: readNumberEnv(
    "PRINT_AGENT_PRINT_TIMEOUT_MS",
    DEFAULT_PRINT_TIMEOUT_MS,
  ),
  allowedOrigins: readListEnv(
    "PRINT_AGENT_ALLOWED_ORIGINS",
    DEFAULT_ALLOWED_ORIGINS,
  ),
};

let printQueue = Promise.resolve();
let jobSequence = 0;
const stats = {
  totalJobs: 0,
  totalPrinted: 0,
  totalFailed: 0,
  queuedJobs: 0,
  activeJobId: null,
  lastJobId: null,
  lastPrintedAt: null,
  lastFailedAt: null,
  lastError: null,
};

if (process.argv.includes("--help")) {
  printHelp();
  process.exit(0);
}

if (process.argv.includes("--list-printers")) {
  try {
    const printers = await listPrinters();
    process.stdout.write(`${JSON.stringify(printers, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    log("printer list error", { error: getErrorMessage(error) });
    process.exit(1);
  }
}

const server = http.createServer(async (request, response) => {
  const corsAllowed = setCorsHeaders(request, response);

  if (!corsAllowed) {
    response.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("CORS origin is not allowed.");
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      handleHealth(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/printers") {
      await handlePrinters(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/print") {
      await handlePrint(request, response);
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: "Not found",
      routes: ["GET /health", "GET /printers", "POST /print"],
    });
  } catch (error) {
    log("request error", { error: getErrorMessage(error) });
    sendJson(response, 500, {
      ok: false,
      error: getErrorMessage(error),
    });
  }
});

server.listen(
  {
    port: config.port,
    ...(config.host ? { host: config.host } : {}),
  },
  () => {
    const address = server.address();
    const bind =
      typeof address === "object" && address
        ? `${address.address}:${address.port}`
        : `:${config.port}`;

    log("agent started", {
      bind,
      health: `http://localhost:${config.port}/health`,
      printerName: config.printerName || "Windows default printer",
      rawEncoding: config.rawEncoding,
      allowedOrigins: config.allowedOrigins,
    });
  },
);

function handleHealth(request, response) {
  log("health hit", {
    remoteAddress: request.socket.remoteAddress,
    method: request.method,
  });

  sendJson(response, 200, {
    ok: true,
    service: SERVICE_NAME,
    port: config.port,
    printerName: config.printerName || null,
    defaultPrinterFallback: !config.printerName,
    platform: process.platform,
    stats: { ...stats },
  });
}

async function handlePrinters(response) {
  log("printers hit");

  if (process.platform !== "win32") {
    sendJson(response, 501, {
      ok: false,
      error: "Printer listing is implemented for Windows only.",
    });
    return;
  }

  const printers = await listPrinters();

  sendJson(response, 200, {
    ok: true,
    printers,
  });
}

async function handlePrint(request, response) {
  const requestId = randomUUID();
  const body = await readJsonBody(request);

  log("print hit", {
    requestId,
    adapter: body?.adapter,
    format: body?.format,
    ticketCode: body?.ticketCode,
  });

  if (!body || typeof body !== "object") {
    sendJson(response, 400, {
      ok: false,
      error: "JSON body is required.",
    });
    return;
  }

  if (body.adapter !== "escpos" || body.format !== "raw") {
    sendJson(response, 415, {
      ok: false,
      error: 'Only adapter="escpos" and format="raw" is supported.',
    });
    return;
  }

  if (typeof body.raw !== "string" || body.raw.length === 0) {
    sendJson(response, 400, {
      ok: false,
      error: 'Body field "raw" must be a non-empty string.',
    });
    return;
  }

  const prepared = prepareRawPayload(body.raw, body.cut === true);
  const job = enqueuePrintJob(async (jobId) => {
    try {
      log("print job started", {
        requestId,
        jobId,
        printerName: config.printerName || "Windows default printer",
        rawLength: prepared.rawLength,
        byteLength: prepared.buffer.length,
        cutRequested: body.cut === true,
        cutAlreadyPresent: prepared.cutAlreadyPresent,
        cutAppended: prepared.cutAppended,
      });

      const result = await printRawEscpos(prepared.buffer, config.printerName);

      log("print job success", {
        requestId,
        jobId,
        printerName: result.printerName,
        bytes: result.bytes,
      });
      stats.totalPrinted += 1;
      stats.lastPrintedAt = new Date().toISOString();

      return result;
    } catch (error) {
      log("print job error", {
        requestId,
        jobId,
        error: getErrorMessage(error),
      });
      stats.totalFailed += 1;
      stats.lastFailedAt = new Date().toISOString();
      stats.lastError = getErrorMessage(error);

      throw error;
    }
  });

  try {
    const result = await withTimeout(job.promise, config.responseTimeoutMs);
    sendJson(response, 200, {
      ok: true,
      requestId,
      jobId: job.jobId,
      status: "printed",
      printerName: result.printerName,
      bytes: result.bytes,
      cutAppended: prepared.cutAppended,
    });
  } catch (error) {
    if (error instanceof TimeoutError) {
      log("print job accepted", {
        requestId,
        jobId: job.jobId,
        status: "queued",
        responseTimeoutMs: config.responseTimeoutMs,
      });

      sendJson(response, 202, {
        ok: true,
        requestId,
        jobId: job.jobId,
        status: "queued",
        message: "Print job accepted and is still running.",
      });
      return;
    }

    log("print response error", {
      requestId,
      jobId: job.jobId,
      error: getErrorMessage(error),
    });

    sendJson(response, 500, {
      ok: false,
      requestId,
      jobId: job.jobId,
      error: getErrorMessage(error),
    });
  }
}

function enqueuePrintJob(runJob) {
  const jobId = `${Date.now()}-${++jobSequence}`;
  stats.totalJobs += 1;
  stats.queuedJobs += 1;
  stats.lastJobId = jobId;

  const runTrackedJob = async () => {
    stats.queuedJobs = Math.max(0, stats.queuedJobs - 1);
    stats.activeJobId = jobId;

    try {
      return await runJob(jobId);
    } finally {
      if (stats.activeJobId === jobId) {
        stats.activeJobId = null;
      }
    }
  };

  const promise = printQueue.then(runTrackedJob, runTrackedJob);

  printQueue = promise.catch((error) => {
    log("print queue job failed", {
      jobId,
      error: getErrorMessage(error),
    });
  });

  return { jobId, promise };
}

function prepareRawPayload(raw, cutRequested) {
  const cutAlreadyPresent = hasCutCommand(raw);
  const cutAppended = cutRequested && !cutAlreadyPresent;
  const printableRaw = cutAppended ? `${raw}${ESC_POS_CUT}` : raw;

  return {
    rawLength: printableRaw.length,
    cutAlreadyPresent,
    cutAppended,
    buffer: rawStringToBuffer(printableRaw, config.rawEncoding),
  };
}

function rawStringToBuffer(raw, encoding) {
  if (encoding === "utf8" || encoding === "utf-8") {
    return Buffer.from(raw, "utf8");
  }

  if (encoding !== "latin1" && encoding !== "binary") {
    log("unknown raw encoding, falling back to latin1", { encoding });
  }

  return Buffer.from(raw, "latin1");
}

function hasCutCommand(raw) {
  return (
    raw.includes("\x1D\x56\x00") ||
    raw.includes("\x1D\x56\x01") ||
    raw.includes("\x1D\x56\x41") ||
    raw.includes("\x1D\x56\x42") ||
    raw.includes("\x1B\x69") ||
    raw.includes("\x1B\x6D")
  );
}

async function printRawEscpos(buffer, printerName) {
  if (process.platform !== "win32") {
    throw new Error("Raw ESC/POS printing is implemented for Windows only.");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nextcross-print-"));
  const dataPath = path.join(tempDir, "receipt.bin");

  try {
    await fs.writeFile(dataPath, buffer);

    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "windows-raw-print.ps1"),
      "-DataPath",
      dataPath,
    ];

    if (printerName) {
      args.push("-PrinterName", printerName);
    }

    const { stdout } = await execFileAsync("powershell.exe", args, {
      timeout: config.printTimeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    return parsePowerShellJson(stdout);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function listPrinters() {
  if (process.platform !== "win32") {
    throw new Error("Printer listing is implemented for Windows only.");
  }

  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "windows-list-printers.ps1"),
    ],
    {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );

  const parsed = parsePowerShellJson(stdout);
  return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
}

function parsePowerShellJson(stdout) {
  const text = String(stdout || "").trim();

  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw new Error(
        `Request body is too large. Limit is ${MAX_BODY_BYTES} bytes.`,
      );
    }

    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();

  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`Invalid JSON body: ${getErrorMessage(error)}`);
  }
}

function sendJson(response, statusCode, payload) {
  const data = JSON.stringify(payload);

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  response.end(data);
}

function setCorsHeaders(request, response) {
  const origin = request.headers.origin;
  const allowedOrigin = getAllowedCorsOrigin(origin);

  response.setHeader("Vary", "Origin");

  if (origin && !allowedOrigin) {
    return false;
  }

  if (allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization",
  );
  response.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

function getAllowedCorsOrigin(origin) {
  if (!origin) {
    return "";
  }

  if (config.allowedOrigins.includes("*")) {
    return origin;
  }

  return config.allowedOrigins.includes(origin) ? origin : "";
}

function loadEnvFile(filePath) {
  try {
    const content = requireTextFileSync(filePath);

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim());

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log("env file load warning", {
        filePath,
        error: getErrorMessage(error),
      });
    }
  }
}

function requireTextFileSync(filePath) {
  return readFileSync(filePath, "utf8");
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readOptionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || "";
}

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readListEnv(name, fallback) {
  const value = process.env[name]?.trim();

  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function log(message, details = {}) {
  const detailsText =
    details && Object.keys(details).length > 0
      ? ` ${JSON.stringify(details)}`
      : "";

  console.log(`[${new Date().toISOString()}] ${message}${detailsText}`);
}

function printHelp() {
  process.stdout.write(`NextCross Local Print Agent

Usage:
  npm run print-agent
  npm run print-agent:list-printers

Environment:
  PRINT_AGENT_PORT=9191
  PRINT_AGENT_PRINTER_NAME="Your thermal printer name"
  PRINT_AGENT_RAW_ENCODING=latin1
  PRINT_AGENT_RESPONSE_TIMEOUT_MS=2500
  PRINT_AGENT_PRINT_TIMEOUT_MS=20000
  PRINT_AGENT_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,https://testapp.nextcross.az,https://app.nextcross.az

Endpoints:
  GET  /health
  GET  /printers
  POST /print
`);
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}
