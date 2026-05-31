# NextCross Local Print Agent

Windows-da React/Vite `/test` səhifəsindən raw ESC/POS thermal receipt çap etmək üçün lokal agent.

## İşə salma

```powershell
npm run print-agent
```

Health yoxlaması:

```powershell
Invoke-RestMethod http://localhost:9191/health
```

Printerləri görmək:

```powershell
npm run print-agent:list-printers
```

## Printer seçimi

Agent printer adı verilməyəndə Windows default printerini istifadə edir. Konkret thermal printer seçmək üçün `local-print-agent/.env.example` faylını `local-print-agent/.env` kimi kopyalayın və printer adını yazın:

```env
PRINT_AGENT_PRINTER_NAME=POS-80C
```

Alternativ olaraq PowerShell-də env ilə işə sala bilərsiniz:

```powershell
$env:PRINT_AGENT_PRINTER_NAME="POS-80C"
npm run print-agent
```

## Endpointlər

`GET /health`

Tez `200` qaytarır və agentin işlədiyini göstərir.

`GET /printers`

Windows printer queue-larını JSON kimi qaytarır.

`POST /print`

Bu formatı qəbul edir:

```json
{
  "ticketCode": "A-001",
  "branch": "Kassa",
  "service": "Odenis",
  "createdAt": "current date/time",
  "message": "Zehmet olmasa novbenizi gozleyin",
  "adapter": "escpos",
  "format": "raw",
  "raw": "...ESC/POS commands...",
  "cut": true
}
```

`adapter: "escpos"` və `format: "raw"` olduqda `raw` string byte kimi Windows printer spooler-ə `RAW` data type ilə göndərilir. `cut: true` gəlibsə və raw data içində cut əmri yoxdursa, agent `GS V 0` (`1D 56 00`) əlavə edir. Raw data artıq cut əmri daşıyırsa, təkrar əlavə etmir.

## Config

| Env | Default | İzah |
| --- | --- | --- |
| `PRINT_AGENT_PORT` | `9191` | Agent portu |
| `PRINT_AGENT_HOST` | `localhost` | Agent bind host-u |
| `PRINT_AGENT_PRINTER_NAME` | boş | Boşdursa Windows default printer |
| `PRINTER_NAME` | boş | Alternativ printer env adı |
| `PRINT_AGENT_RAW_ENCODING` | `latin1` | Raw string byte mapping |
| `PRINT_AGENT_RESPONSE_TIMEOUT_MS` | `2500` | Frontend timeoutuna düşməmək üçün cavab gözləmə müddəti |
| `PRINT_AGENT_PRINT_TIMEOUT_MS` | `20000` | Windows raw print job timeout |

## Test

Agent işləyəndən sonra Vite app-də `/test` səhifəsində `Agent yoxla` basanda `GET http://localhost:9191/health` `200` dönməlidir. Sonra `ESC/POS print test` raw ESC/POS data-nı `POST http://localhost:9191/print` endpointinə göndərəcək.
