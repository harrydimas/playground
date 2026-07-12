# HS Code Classification System — Development Plan

**Scope:** Klasifikasi otomatis product description → kode HS 6-digit (WCO), berbasis data seperti `example.csv`
**Type:** Batch/pipeline classification system (bukan chatbot) dengan retrieval + GRI-based reasoning

---

## 1. Objective

Bangun sistem yang menerima input **description** (satu baris atau batch/CSV, format seperti `example.csv`: `PO Item Description → HS Code`) dan mengembalikan **kode HS 6-digit** yang tepat, dengan:
- Rationale klasifikasi (Section → Chapter → Heading → Subheading)
- Sitasi legal notes / GRI yang dipakai
- Confidence indicator per baris
- Flag `needs_review` untuk kasus ambigu (bukan pertanyaan interaktif, karena sistem bekerja secara batch — lihat catatan di 4)

**Input/output model:**
```
Input:  "PLATE;TAIL LNR M1500,1500 X 1500,PP"
Output: {
  "hscode": "84749000",
  "confidence": "medium",
  "reasoning_trace": {...},
  "needs_review": false
}
```

---

## 2. Phase Breakdown

### Phase 1 — Data Acquisition & Structuring (Week 1–2)

**Status: partially done.** Dataset sudah tersedia:
- `sections.csv` — 21 baris (Section I–XXI + nama)
- `harmonized-system.csv` — 6,940 baris: 97 chapter (level 2), 1,229 heading (level 4), 5,613 subheading (level 6), lengkap dengan kolom `parent` untuk hierarki
- `example.csv` — **761 baris data historis real** (PO Item Description → HS Code), 203 kode unik — dataset ini sangat berharga sebagai training/eval set, lihat temuan di 1.1

**1.1 Temuan dari analisis `example.csv` (penting untuk desain sistem)**

| Temuan | Detail | Implikasi |
|---|---|---|
| **Ambiguitas kata generik sangat tinggi** | Kata pertama yang sama ("VALVE", "PUMP", "COUPLING", "KIT", "MODULE") mapping ke 5–11 kode HS berbeda tergantung konteks mesin/model | Confirms isu part-vs-material (3.3) bukan edge case — ini **mayoritas kasus**. Entity extraction nama mesin/model (contoh: `DD422I`, `Cabolter`, `SOLO DL432i`) wajib, bukan opsional |
| **~4-5% baris bukan barang fisik** | Item seperti "Freight Charges", "Master Data and Document Register", "Cancellation charges", "25% Down Payment" ikut ter-assign kode HS (kemungkinan warisan dari sistem ERP yang asal-copy kode item fisik terdekat di PO yang sama) | Data ini **noise**, harus difilter sebelum dipakai training/eval, dan sistem harus bisa mendeteksi + menolak klasifikasi untuk deskripsi non-barang (jasa, dokumen, biaya, pembayaran) |
| **Distribusi kode long-tail** | 203 kode unik dari 761 baris; kode terpopuler (`84314300` — parts of boring/sinking machinery, dominan karena banyak part mesin bor tambang) muncul 78x, banyak kode lain hanya 1x | Retrieval + reasoning harus tetap akurat di kode-kode jarang (long tail), bukan cuma optimasi kode populer |
| **Vocabulary singkatan konsisten** | Singkatan seperti PMP, CNVYR, ASSY, HYD, CBL, MTG, CNTRL, VLV, MTR, FLTR, LNR dipakai berulang di seluruh dataset | Bisa dipakai untuk **membangun kamus singkatan (3.1) langsung dari data ini**, bukan dari nol |

**Yang masih kurang (blocker untuk akurasi tinggi):**

| Task | Detail | Status |
|---|---|---|
| Section & Chapter Legal Notes | Teks resmi WCO Explanatory Notes — aturan exclude/include per chapter | ❌ Belum ada |
| Teks resmi GRI 1–6 | Enam General Rules for Interpretation, verbatim dari WCO | ❌ Belum ada |
| Normalize ke schema relasional | Lihat schema di Section 3 | ⏳ Perlu dibuat |
| Chapter cross-reference table | Menangkap relasi "excludes — see chapter X" | ❌ Belum ada |
| Cleaning `example.csv` | Filter baris non-barang-fisik sebelum dipakai sebagai train/eval set | ⏳ Perlu dibuat |

**Deliverable:** Postgres database terisi kode + hierarki (dari data existing) + notes & GRI (perlu disourcing terpisah dari WCO Explanatory Notes/HS Nomenclature resmi) + cleaned `example.csv` sebagai labeled eval set.

---

### Phase 2 — Database & Retrieval Layer (Week 2–3)

**Database:** PostgreSQL + pgvector (scale is ~5,300 rows — no need for a dedicated vector DB)

**Schema (draft):**
```sql
CREATE TABLE hs_sections (
  section_id INT PRIMARY KEY,
  title TEXT,
  notes TEXT
);

CREATE TABLE hs_chapters (
  chapter_id INT PRIMARY KEY,
  section_id INT REFERENCES hs_sections(section_id),
  title TEXT,
  notes TEXT,
  exclusions TEXT
);

CREATE TABLE hs_codes (
  code VARCHAR(6) PRIMARY KEY,
  heading VARCHAR(4),
  chapter_id INT REFERENCES hs_chapters(chapter_id),
  description TEXT,
  embedding VECTOR(1536)
);

CREATE TABLE gri_rules (
  rule_id INT PRIMARY KEY,
  rule_text TEXT,
  embedding VECTOR(1536)
);
```

**Embedding strategy:**
- Embed each `hs_codes.description` concatenated with parent chapter title (adds disambiguating context)
- Use a general-purpose embedding model to start (e.g., OpenAI `text-embedding-3-small` or Cohere embed) — evaluate domain-specific fine-tuning later if accuracy is insufficient
- Index with pgvector HNSW

**Retrieval mode:** Hybrid (vector + keyword/BM25 via Postgres full-text search), since HS descriptions use precise technical terminology that pure vector similarity can blur.

**Deliverable:** Working retrieval function returning top-k candidate codes + relevant chapter/section notes for a given query.

---

### Phase 3 — Classification Reasoning Engine (Week 3–5)

This is the core differentiator vs. naive RAG. See companion doc: `gri-reasoning-prompt-template.md` for full system/user prompt template.

**3.1 Pre-processing input (industrial descriptions sering disingkat)**

Deskripsi produk real-world jarang berupa kalimat rapi — sering berupa string industri padat, contoh:
```
PLATE;TAIL LNR M1500,1500 X 1500,PP
```
Sebelum masuk ke retrieval, tambahkan **normalization step**:
- Ekspansi singkatan umum (PP → Polypropylene, LNR → Liner, dll) — bangun kamus singkatan domain-spesifik dari data historis (`example.csv` sudah punya vocabulary konsisten yang bisa langsung dipakai sebagai starting dictionary, lihat 1.1)
- Ekstraksi entitas terstruktur: nama barang, bahan, dimensi, model/part number, **nama mesin/equipment induk** (contoh: `DD422I`, `Cabolter`, `SOLO DL432i` — krusial untuk disambiguasi, lihat 1.1 soal ambiguitas kata generik)
- Dimensi & part number **tidak** dipakai untuk embedding (noise), tapi disimpan untuk konteks reasoning

**3.1.1 Deteksi item non-barang-fisik (gate sebelum klasifikasi)**

Data real (`example.csv`) menunjukkan ~4-5% baris PO sebenarnya bukan barang fisik — jasa, dokumen, biaya, pembayaran (misal "Freight Charges", "Certificate of Compliance", "25% Down Payment", "Cancellation charges"). Item seperti ini **tidak punya kode HS yang valid** secara prinsip (HS code hanya untuk barang yang diperdagangkan lintas batas, bukan jasa/dokumen/biaya administratif).

→ Tambahkan **gate check** di awal pipeline, sebelum retrieval:
- Jika deskripsi cocok pola non-barang (keyword: freight, charge, payment, inspection, drawing, document, certificate, manual, catalog, register, surcharge, deferment, test report, procedure, dll, atau deskripsi berupa persentase pembayaran) → tandai `status: not_applicable`, jangan paksa retrieval/klasifikasi
- Ini mencegah sistem "ngarang" kode HS untuk baris yang secara definisi gak butuh kode HS

**3.2 GRI-based reasoning (berurutan, GRI 1 → GRI 6)**

Alur reasoning wajib mengikuti urutan resmi WCO, tidak boleh lompat:

| GRI | Kapan dipakai | Contoh kasus |
|---|---|---|
| **1** | Default pertama — cek apakah judul heading + section/chapter notes sudah eksplisit cover produk | "Horses; live" → langsung heading 0101 |
| **2(a)** | Barang belum lengkap/belum jadi tapi sudah punya essential character barang jadinya | Sepeda tanpa pedal tetap "sepeda" |
| **2(b)** | Barang = bahan dicampur bahan lain | Kain campuran serat → lanjut ke GRI 3 |
| **3(a)** | Ada beberapa heading kandidat → pilih paling spesifik | "Sports footwear" > "footwear" umum |
| **3(b)** | Barang komposit/set → tentukan essential character | Set alat makan + kotak kayu → alat makan yang menentukan |
| **3(c)** | 3(a)/3(b) masih seri → pilih heading bernomor terbesar | Fallback terakhir |
| **4** | Tidak ada preseden sama sekali → pakai barang paling mirip | Produk benar-benar baru |
| **5** | Soal kemasan/case | Case kamera ikut kamera |
| **6** | Ulangi 1–5 di level subheading (6 digit), hanya banding antar subheading setara | Pemilihan 6-digit final |

**3.3 Isu kritis: "material generik" vs "part fungsional"**

Kasus nyata (dari test dengan data existing): deskripsi seperti *"PLATE;TAIL LNR M1500,1500 X 1500,PP"* punya kandidat kuat di **chapter 39 (plastics)** — misal `392020` (plates, polymers of propylene) — berdasarkan bahan (PP) dan bentuk (plate).

Tapi indikator seperti part number (`M1500`) dan istilah "TAIL LNR" (kemungkinan liner untuk mesin/alat berat tertentu) mengindikasikan produk ini bisa jadi **part spesifik untuk satu jenis mesin/kendaraan**, yang harusnya masuk chapter parts mesin tersebut (chapter 84/87), **bukan** diklasifikasikan berdasarkan bahan bakunya.

→ **Reasoning engine wajib punya decision branch eksplisit untuk kasus ini:**
1. Apakah deskripsi menyebut nama mesin/kendaraan/aplikasi spesifik? → kemungkinan part, arahkan ke chapter mesin terkait, turunkan confidence, flag `needs_review: true`
2. Apakah deskripsi hanya menyebut bahan + bentuk generik (plate, sheet, rod)? → klasifikasi berdasarkan bahan valid (chapter 39/72/73/dst)
3. Jika ambigu → **selalu flag `needs_review: true`** dengan alasan + kandidat alternatif, jangan asumsi salah satu (karena ini sistem batch, tidak ada user untuk ditanya real-time — lihat Phase 4)

Ini prinsip section/chapter notes yang sering jadi pengecualian: banyak chapter barang jadi (mesin, kendaraan, dll) punya notes yang bilang "part yang dikenali sebagai bagian eksklusif dari mesin ini tidak masuk chapter [bahan]". Tanpa notes ini ter-load ke database, LLM cenderung salah default ke klasifikasi berdasarkan bahan.

**3.4 Approach — retrieval → reasoning pipeline**
1. Normalize & extract entities dari input (3.1)
2. Retrieve top-k (5–10) candidate codes + chapter/section notes relevan
3. Prompt LLM reasoning top-down: Section → Chapter → Heading → Subheading, mengikuti tabel GRI (3.2)
4. Cek explicit "part vs material" branch (3.3) jika deskripsi mengandung indikasi part number/model/aplikasi mesin
5. Jika kandidat konflik atau info kurang (bahan, fungsi, apakah part khusus) → flag `needs_review: true` dengan kandidat alternatif, jangan paksa satu jawaban (lihat Phase 4 soal handling batch)
6. Output kode final + full rationale trace + GRI yang dipakai + confidence

**Prompt design principles:**
- Force explicit citation GRI mana yang dipakai di tiap level (section/chapter/heading/subheading)
- Force explicit check terhadap chapter notes exclusion sebelum finalize
- Require confidence level (High/Medium/Low) dengan alasan penurunan confidence jika notes belum lengkap
- Never allow output kode tanpa rationale trace
- Output selalu sertakan boolean `needs_review` — sistem batch tidak bisa nanya balik real-time, jadi baris low-confidence harus eksplisit ditandai untuk verifikasi manusia, bukan dipaksa jadi jawaban final

**Deliverable:** Classification pipeline (normalize → retrieval → GRI reasoning → structured JSON output) tested against a labeled sample set. Prompt template detail: lihat `gri-reasoning-prompt-template.md`.

---

### Phase 4 — Batch Processing & Output Layer (Week 5–6)

Karena ini sistem klasifikasi batch (bukan chatbot interaktif), penanganan ambiguitas harus **tanpa** tanya-jawab real-time. Pendekatannya:

- **Input:** terima file CSV (format sama seperti `example.csv`: kolom description, opsional kolom lain) atau single description via API call
- **Batch runner:** proses tiap baris lewat pipeline (Phase 3), paralel/batched untuk efisiensi biaya API
- **Output:** CSV/JSON hasil dengan kolom tambahan: `hscode`, `confidence`, `reasoning_trace`, `gri_applied`, `needs_review` (boolean)
- **Handling ambiguitas tanpa interaksi:**
  - Kasus `confidence: low` atau `needs_review: true` **tidak** dipaksa dapat kode — tampilkan kandidat top-2/3 + alasan kenapa ambigu, biarkan reviewer manusia yang putuskan
  - Kasus item non-fisik (gate 3.1.1) → `status: not_applicable`, tidak masuk hitungan akurasi
  - Opsional: expose endpoint terpisah untuk "resubmit dengan konteks tambahan" (misal reviewer menambahkan info bahan/mesin induk secara manual), tapi ini bukan percakapan multi-turn, cuma retry dengan input yang diperkaya
- **Review dashboard (opsional, kalau volume PO tinggi):** tabel sortable by confidence, biar reviewer fokus ke baris `needs_review` dulu, bukan cek semua baris satu-satu

**Deliverable:** Batch classification pipeline (CSV in → CSV/JSON out) + API endpoint untuk single-item classification, terintegrasi dengan output review-friendly.

---

### Phase 5 — Evaluation & Accuracy Testing (Week 6–7)

**Dataset utama: `example.csv` (761 baris berlabel real).** Sebelum dipakai, bersihkan dulu (buang ~33 baris item non-fisik, lihat 1.1), lalu split train/eval (misal 80/20, atau pakai seluruhnya sebagai eval set karena volumenya masih kecil untuk fine-tuning).

| Test type | Method |
|---|---|
| Exact match accuracy | Jalankan seluruh `example.csv` (cleaned) lewat pipeline, ukur % kode 6-digit yang cocok persis dengan label |
| Ambiguous-term stress test | Fokus khusus ke 15 kata generik yang teridentifikasi ambigu di 1.1 (VALVE, PUMP, COUPLING, KIT, MODULE, dll) — pastikan sistem berhasil disambiguasi pakai entitas mesin/model, bukan asal tebak kandidat top-1 |
| Long-tail coverage | Cek akurasi khusus untuk kode yang cuma muncul 1-2x di dataset (bukan cuma kode populer seperti 84314300) |
| Non-physical item rejection | Uji gate check (3.1.1) dengan baris yang sengaja mengandung deskripsi jasa/dokumen/biaya — pastikan sistem menandai `not_applicable`, bukan memaksa klasifikasi |
| Additional labeled test set | Curate ~200–500 deskripsi tambahan di luar `example.csv` dengan kode HS terverifikasi (customs rulings database) untuk cross-check generalisasi |
| Ambiguity handling | Pastikan kasus genuinely ambiguous memicu flag `needs_review: true`, bukan jawaban asal percaya diri |
| Edge cases | Composite goods, sets, unfinished/incomplete articles (GRI 2), parts and accessories |
| Industrial abbreviation test set | Kumpulkan sample deskripsi asli format industri (singkatan, part number, dimensi) untuk uji normalization step (3.1) |
| Part vs material test set | Kasus khusus barang yang bisa salah klasifikasi berdasarkan bahan vs sebagai part mesin (lihat 3.3) — pastikan sistem flag `needs_review`, bukan menebak. `example.csv` sudah punya banyak contoh nyata untuk kasus ini (PLATE, LINER, COUPLING, dll) |

**Deliverable:** Accuracy report berbasis `example.csv` sebagai baseline real, plus breakdown akurasi per kategori (ambiguous term, long-tail, non-physical rejection); iterate on retrieval/prompting based on failure patterns.

---

### Phase 6 — Deployment & Monitoring (Week 7–8)

- Deploy sebagai API endpoint (single-item) + batch job runner (CSV upload → CSV hasil, bisa async untuk file besar)
- Log seluruh klasifikasi + rationale (penting untuk audit, mengingat implikasi compliance/duty)
- Feedback loop: reviewer koreksi baris `needs_review` atau baris yang salah → masuk ke labeled dataset untuk iterasi berikutnya (memperbesar `example.csv` dari waktu ke waktu)
- Threshold confidence: baris `confidence: low` otomatis ke-flag `needs_review`, tidak dikirim sebagai hasil final tanpa verifikasi manusia

---

## 3. Tech Stack Summary

| Layer | Choice | Why |
|---|---|---|
| Database | PostgreSQL + pgvector | Scale (~5K rows) doesn't need a dedicated vector DB; relational structure fits the HS hierarchy well |
| Embeddings | OpenAI / Cohere (general-purpose to start) | Fast to implement; evaluate fine-tuning later |
| Retrieval | Hybrid (pgvector + Postgres full-text search) | Technical terminology needs exact-match support alongside semantic search |
| Reasoning | LLM with structured hierarchical prompting | GRI-based reasoning is the core accuracy driver, not raw retrieval |
| Interface | Batch API + CSV in/out, optional review dashboard | Ini sistem klasifikasi batch, bukan chatbot — tidak butuh multi-turn conversational UI |

---

## 4. Key Risks

- **False confidence:** Sistem output kode tanpa justifikasi cukup → mitigasi dengan mandatory rationale + confidence scoring + flag `needs_review` untuk kasus low-confidence (bukan tanya interaktif, karena ini batch)
- **Missing legal notes:** Classification without chapter/section notes will systematically miss exclusion rules → notes are not optional context, they're required
- **Composite/ambiguous goods:** Straightforward retrieval fails on sets, mixed materials, unfinished goods → GRI 2/3 reasoning must be explicit in prompting
- **Part vs. material misclassification:** Industrial parts described by raw material (e.g., "PP plate") can be misclassified under the material chapter (39) instead of the parent machine/vehicle chapter (84/87) — this is the single highest-risk failure mode without chapter notes loaded; mitigate with explicit decision branch (see Phase 3.3) and mandatory `needs_review` flag when part numbers/model codes are present. **Validated dengan data real:** kata generik seperti VALVE, PUMP, COUPLING mapping ke 5-11 kode berbeda di `example.csv` — ini bukan edge case, tapi mayoritas kasus
- **Training data noise:** Data historis PO (seperti `example.csv`) sering mengandung baris non-barang-fisik (freight, dokumen, biaya) yang ikut ter-assign kode HS secara tidak valid — kalau dipakai mentah untuk training/eval, model bisa belajar pola salah. Wajib dibersihkan dulu (lihat 1.1 & 3.1.1)
- **Compliance liability:** Always disclose that output is a classification aid, not a binding ruling

---

## 5. Next Steps

1. ~~Confirm WCO HS dataset source~~ — Done: `harmonized-system.csv` (6,940 rows), `sections.csv` (21 rows), `example.csv` (761 labeled real examples) in hand
2. Clean `example.csv` — filter ~33 non-physical-item rows (freight/document/payment), keep as primary eval set
3. Source official WCO Section/Chapter Notes text + GRI 1–6 verbatim text (blocker for high-confidence reasoning)
4. Stand up Postgres + pgvector instance, ingest existing CSVs into schema (Section 3)
5. Build abbreviation/entity normalization step (3.1) — mine initial dictionary directly from `example.csv` vocabulary (PMP, CNVYR, ASSY, HYD, CBL, etc.)
6. Prototype retrieval + GRI reasoning on a small chapter subset (e.g., Chapter 39 — plastics, since already validated with test query) before scaling to full nomenclature
7. Build part-vs-material test set to validate the decision branch (3.3) using the 15+ ambiguous generic terms already identified in `example.csv` (VALVE, PUMP, COUPLING, KIT, MODULE, etc.)
8. Run full `example.csv` (cleaned) through prototype pipeline as first real accuracy baseline
