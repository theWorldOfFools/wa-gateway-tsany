import type { AnalysisResultData } from '../domain.js';

export const INTERNAL_ANALYZER_VERSION = 'heuristic-v1';

const POSITIVE_WORDS = new Set([
  'bagus', 'baik', 'mantap', 'senang', 'puas', 'cepat', 'membantu',
  'terima', 'kasih', 'makasih', 'thanks', 'thank', 'sukses', 'setuju',
  'oke', 'ok', 'yes', 'great', 'awesome', 'love', 'ramah', 'mudah'
]);

const NEGATIVE_WORDS = new Set([
  'kecewa', 'buruk', 'lambat', 'gagal', 'error', 'rusak', 'gangguan',
  'sulit', 'mahal', 'komplain', 'keluhan', 'marah', 'benci', 'batal',
  'salah', 'nggak', 'tidak', 'bad', 'slow', 'wrong', 'suck', 'lapor'
]);

const STOP_WORDS = new Set([
  'yang', 'dan', 'dengan', 'untuk', 'dari', 'pada', 'ini', 'itu', 'atau',
  'akan', 'saya', 'kamu', 'anda', 'kami', 'mereka', 'sudah', 'agar',
  'jika', 'maka', 'bisa', 'ada', 'adalah', 'paling', 'sangat', 'banget',
  'nih', 'sih', 'deh', 'ya', 'yuk', 'juga', 'kalau', 'karena', 'supaya',
  'supaya', 'http', 'https', 'www'
]);

const INTENT_PATTERNS: Array<{ intent: string; pattern: RegExp }> = [
  {
    intent: 'opt_out',
    pattern: /\b(stop|unsubscribe|berhenti|jangan\s+kirim|hapus\s+nomor)\b/
  },
  {
    intent: 'complaint',
    pattern: /\b(keluhan|komplain|kecewa|lapor|masalah|gangguan|rusak)\b/
  },
  {
    intent: 'order',
    pattern: /\b(pesan|order|beli|checkout|harga|paket|produk|langganan)\b/
  },
  {
    intent: 'thanks',
    pattern: /\b(terima\s+kasih|makasih|thanks|thank\s+you)\b/
  },
  {
    intent: 'greeting',
    pattern: /\b(halo|hallo|hai|hi|permisi|selamat|pagi|siang|sore|malam)\b/
  },
  {
    intent: 'question',
    pattern: /\b(apa|kapan|bagaimana|berapa|dimana|kenapa|boleh|apakah)\b|\?/
  }
];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Deterministic, dependency-free analysis. It is intentionally conservative:
 * unknown text is neutral/other rather than guessing. External analyzers can
 * replace or complement these results through the analysis configuration.
 */
export function analyzeTextInternal(
  text: string,
  maxChars = 4_096
): AnalysisResultData {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  const words = tokens(clean);
  const unique = new Set(words);

  let positive = 0;
  let negative = 0;
  for (const word of unique) {
    if (POSITIVE_WORDS.has(word)) positive += 1;
    if (NEGATIVE_WORDS.has(word)) negative += 1;
  }

  const total = positive + negative;
  const label =
    positive > negative ? 'positive' : negative > positive ? 'negative' : 'neutral';
  const score = total === 0 ? 0 : (positive - negative) / total;

  const intent =
    INTENT_PATTERNS.find(({ pattern }) => pattern.test(` ${clean.toLowerCase()} `))
      ?.intent ?? 'other';

  const frequencies = new Map<string, number>();
  for (const word of words) {
    if (word.length < 4 || STOP_WORDS.has(word)) continue;
    if (POSITIVE_WORDS.has(word) || NEGATIVE_WORDS.has(word)) continue;
    frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }
  const keywords = [...frequencies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word]) => word);

  const summary = clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;

  return { label, intent, score, keywords, summary };
}
