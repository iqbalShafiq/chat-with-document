# Deep Research Activity UX — QA Report

Tanggal: 23 Agustus 2026
Branch: `feat/data-analysis-deep-research`
Base sebelum perubahan: `d50db2d`

## Hasil

Deep Research sekarang menampilkan panel aktivitas yang ringkas dan dapat dibuka-tutup di luar glass container composer, tepat di atas text field. Panel ini memperlihatkan fase, progress retrieval, serta timeline aktivitas aman seperti `Searching the web`, `Reading a web page`, `Reading the dataset`, `Checking evidence and citations`, dan `Preparing the final report`.

Raw chain-of-thought, query, URL, argumen tool, dan isi data tidak dikirim ke UI. Server hanya mengirim metadata aktivitas yang sudah di-whitelist.

## Perubahan yang diverifikasi

- Server mengirim event aktivitas Deep Research dari nested researcher dan data-analysis tools.
- Event progress tidak membawa prompt user; stream hanya mengandung fase, statistik bounded, dan metadata aktivitas.
- Retrieval counter tetap mengikuti budget yang sudah ada; data-analysis calls hanya dilaporkan sebagai aktivitas dan tidak mengubah budget retrieval.
- Platform mereduksi event secara defensif, mengabaikan event malformed, menerima hanya label whitelist, membatasi timeline menjadi 12 item, dan menjaga counter tetap monotonic.
- Composer menampilkan state `Planning research`, `Researching sources`, `Preparing the report`, `Research complete`, dan `Research stopped`.
- Panel timeline menampilkan maksimal 4 baris sekaligus dengan internal vertical scroll ketika aktivitas lebih banyak.
- Panel mendukung collapse/expand, keyboard focus ring, `aria-expanded`, `aria-controls`, dan live status announcement.
- State analysis dataset terlihat nyata pada run dengan `sales.csv`.

## Automated verification

| Command | Result |
| --- | --- |
| `pnpm --filter platform exec vitest run` | 15 files, 102 tests passed |
| `pnpm --filter @assingment/agent exec vitest run --hookTimeout=30000` | 18 files, 175 tests passed |
| `pnpm --filter api exec vitest run --hookTimeout=30000` | 29 files, 255 tests passed |
| `pnpm --filter api build` | passed (`tsc`) |
| `pnpm --filter platform build` | passed; existing large-chunk warning only |
| `git diff --check` | passed |

## Real browser QA

Stack dijalankan lokal dengan API, worker, dan Vite. Model yang dipilih dan terlihat di UI adalah `DeepSeek V4 Flash 0731`.

| State / scenario | Observasi | Screenshot |
| --- | --- | --- |
| Researching, collapsed | Panel tampil dengan `4/8 retrievals`, pesan aktivitas, dan tombol `View activity` | `.playwright-mcp/deep-research-activity/07-public-researching-collapsed.png` |
| Researching, expanded | Timeline menampilkan planning, web search, dan page reads; active state terlihat | `.playwright-mcp/deep-research-activity/08-public-researching-expanded.png` |
| Retrieval complete, report masih diproses | `8/8 retrievals`, seluruh retrieval yang terlihat selesai | `.playwright-mcp/deep-research-activity/09-active-retrieval-expanded.png` |
| Completed | Panel berubah menjadi `Research complete`, menampilkan 11 aktivitas termasuk verification dan synthesis | `.playwright-mcp/deep-research-activity/10-public-completed-expanded.png` |
| Completed mobile | Panel tetap terbaca dan tidak keluar viewport pada 390×844 | `.playwright-mcp/deep-research-activity/11-public-completed-mobile.png` |
| Approval pending | Deep Research tanpa toggle aktif menampilkan approval card dan estimasi bounded run | `.playwright-mcp/deep-research-activity/12-approval-pending-mobile.png` |
| Rejected | Setelah rejection, agent tidak melakukan retrieval dan menjelaskan bahwa riset dihentikan | `.playwright-mcp/deep-research-activity/13-rejected-completed-mobile.png` |
| Data analysis | Run nyata dengan attachment `sales.csv` menampilkan `Reading the dataset`, descriptive statistics, analysis, dan query activity | `.playwright-mcp/deep-research-activity/03-analyzing-expanded.png` |

Regression setelah perubahan layout:

| State / assertion | Observasi | Screenshot |
| --- | --- | --- |
| Relocated panel, desktop | Panel berada di luar container composer; composer kembali menjadi container terpisah | `.playwright-mcp/deep-research-activity/14-relocated-researching-collapsed-viewport.png` |
| Four-row scroll window | Browser assertion: `itemCount=7`, `clientHeight=152`, `scrollHeight=269`; hanya sekitar 4 item terlihat sekaligus | `.playwright-mcp/deep-research-activity/15-relocated-expanded-scroll.png` |
| Retrieval limit | Panel tetap terpisah saat `8/8 retrievals` dan timeline bertambah | `.playwright-mcp/deep-research-activity/16-relocated-retrieval-limit-expanded.png` |
| Relocated completed | State selesai menampilkan verification dan synthesis tanpa masuk ke text field container | `.playwright-mcp/deep-research-activity/17-relocated-completed-expanded.png` |
| Relocated mobile | Pada 390×844, panel tetap berada di atas composer dan timeline tetap terbatas 4 baris | `.playwright-mcp/deep-research-activity/18-relocated-completed-mobile.png` |

Planning dan synthesis memang terverifikasi secara nyata di timeline. Transisi planning awal sangat singkat pada provider ini sehingga tidak sempat diambil sebagai frame terpisah; state synthesis juga selesai cepat, namun bukti final menampilkan `Checking evidence and citations — Done` serta `Preparing the final report — Done`.

## Browser assertions dan catatan

- Toggle timeline diuji melalui browser snapshot dengan `aria-expanded` dan `aria-controls`.
- Panel memakai `role="status"` dengan `aria-live="polite"` untuk pesan terbaru.
- Pada regression run terbaru tidak ada console error maupun warning. Run sebelumnya sempat mencatat dua 404 favicon yang tidak terkait fitur ini.
- Code review pass tidak menemukan Critical issue setelah hardening privacy; prompt, label arbitrary, dan message arbitrary tidak lagi dapat masuk ke activity UI.
- In-app browser provider sempat timeout saat menunggu, lalu QA dilanjutkan memakai Playwright CLI lokal pada browser nyata. Tidak ada bypass terhadap safety guard.
- Run kedua yang akan mengirim ulang `sales.csv` ke provider eksternal diblokir oleh safety guard; sebagai gantinya, state web diuji dengan prompt publik tanpa attachment. Run pertama dengan `sales.csv` sudah berhasil dan menghasilkan report cited.

Screenshot QA disimpan di `.playwright-mcp/deep-research-activity/` dan tidak termasuk perubahan source code.
