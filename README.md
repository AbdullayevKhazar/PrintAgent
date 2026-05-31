# PrinterAgent

PrinterAgent Windows ucun printer agent proqramidir. Proqram kompüterdə işləyir və sistemdəki printerlə əlaqə qurmaq üçün istifadə olunur.

## Yukleme

Hazir `.exe` faylini GitHub Releases bolmesinden yukleyin:

[PrinterAgent.exe yukle](https://github.com/USERNAME/PrinterAgent/releases/latest/download/PrinterAgent.exe)

> Qeyd: `USERNAME` hissəsini öz GitHub istifadəçi adınızla dəyişin. Məsələn: `https://github.com/abdul/PrinterAgent/releases/latest/download/PrinterAgent.exe`

## Qurasdirma

1. Yuxaridaki linkden `PrinterAgent.exe` faylini yukleyin.
2. Yuklenen fayli acin.
3. Windows icaze sorusarsa, `Run anyway` və ya `Yes` secin.
4. Proqram acildiqdan sonra printerinizi secin.
5. Lazim olan melumatlari daxil edib agenti isledin.

## GitHub-a yukleme qaydasi

Layiheni GitHub-a gondermek ucun terminalda bu komandalar isledile biler:

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin https://github.com/USERNAME/PrinterAgent.git
git push -u origin main
```

`USERNAME` hissəsini öz GitHub istifadəçi adınızla dəyişin.

## `.exe` faylini Release kimi elave etmek

1. GitHub-da repo səhifəsini açın.
2. Sağ tərəfdən `Releases` bölməsinə daxil olun.
3. `Create a new release` düyməsinə klik edin.
4. `Tag version` olaraq məsələn `v1.0.0` yazın.
5. `PrinterAgent.exe` faylını ora əlavə edin.
6. `Publish release` düyməsinə klik edin.

Bundan sonra README-dəki yükləmə linki işləyəcək.

## Istifade

Proqram işə düşdükdən sonra arxa planda işləyir. Əgər printerlə bağlı problem yaranarsa:

- Printerin kompüterə qoşulu olduğundan əmin olun.
- Printer driver-inin quraşdırıldığını yoxlayın.
- PrinterAgent proqramını bağlayıb yenidən açın.

## Elaqe

Problem və ya təklif olduqda GitHub repo üzərindən `Issues` bölməsində yaza bilərsiniz.
