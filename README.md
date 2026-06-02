# PrinterAgent

PrinterAgent Windows ucun NextCross printer agent proqramidir. Proqram
komputerde arxa planda isleyir, sistemdeki thermal printerle elaqe qurur ve
GitHub Releases uzerinden avtomatik update ala bilir.

## Yukleme

Istifadeci proqrami yalniz ilk defe GitHub Releases bolmesinden qurur:

[Printer Agent Setup yukle](https://github.com/AbdullayevKhazar/PrintAgent/releases/download/v0.1.0/NextCorePrinterAgent-Setup-0.1.8.exe)

Sonraki versiyalarda `.exe` faylini yeniden el ile yuklemek lazim deyil. Yeni
release cixanda proqram update-i avtomatik yoxlayir, yukleyir ve qurasdirmaq
ucun restart teleb edir.

## Qurasdirma

1. Latest release sehifesinden `Printer Agent Setup` faylini yukleyin.
2. Installer-i acin.
3. Windows icaze sorusarsa, `Run anyway` ve ya `Yes` secin.
4. Proqram acilanda agent arxa planda islemeye baslayacaq.
5. Komputer yeniden acilanda agent avtomatik start olacaq.

## Avtomatik Release Qaydasi

Manual `.exe` upload etmeyin. Yeni versiya ucun:

```bash
npm version patch
git push
git push --tags
```

Tag `v*` formatinda push olunanda GitHub Actions Windows build yaradacaq ve
GitHub Release-e installer, `latest.yml` ve update metadata fayllarini avtomatik
yukleyecek. `latest.yml` fayli auto-update ucun vacibdir.

## Lokal Build

Installer-i lokal yaratmaq ucun:

```bash
npm run dist:win
```

Release-e publish etmek ucun GitHub Actions istifade edin. Lokal publish lazim
olarsa, `GH_TOKEN` set olunmalidir:

```bash
npm run release:win
```

## Istifade

Proqram ise dusdukden sonra arxa planda isleyir. Pencere baglansa da agent
baglanmir. Problem yaranarsa:

- Printerin komputere qosulu oldugundan emin olun.
- Printer driver-inin qurasdirildigini yoxlayin.
- PrinterAgent proqramini baglayib yeniden acin.
- Dashboard-da update ve agent statusunu yoxlayin.

## GitHub Repo

Build config hazirda bu repo ucun qurulub:

```text
AbdullayevKhazar/PrintAgent
```

Repo adi ve ya owner deyisirse, `package.json` daxilindeki `build.publish`
bolmesini yenileyin.
