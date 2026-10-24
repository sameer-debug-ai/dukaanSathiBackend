import Fuse from 'fuse.js';

/** Honorifics people add when speaking that should not block a match. */
const HONORIFICS = /\b(ji|jee|bhaiya|bhaiyya|bhai|bhaisaab|aunty|auntie|uncle|seth|sethji|sahab|saab|saheb|didi|bhabhi|madam|sir|mr|mrs|shri|shree|traders?|store|stores|wale|wala|waale)\b/g;

/** Lowercase + punctuation cleanup, honorifics kept ("sharma ji"). */
export function cleanName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[.'’,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** cleanName without honorifics ("sharma"), used for fuzzy comparison. */
export function normalizeName(s: string): string {
  return cleanName(s).replace(HONORIFICS, ' ').replace(/\s+/g, ' ').trim();
}

export const HONORIFIC_SUFFIX = /^\s+(ji|jee|bhaiya|bhai|aunty|auntie|uncle|seth|sahab|saab|didi|bhabhi|traders?|stores?)\b/i;

export interface MatchTarget {
  id: string;
  name: string;
  aliases: string[];
  subtitle?: string;
}

export interface Candidate {
  id: string;
  name: string;
  subtitle?: string;
  /** 0..1, higher is better. */
  score: number;
}

export type MatchStatus = 'matched' | 'ambiguous' | 'not_found';

export interface EntityMatch {
  query: string;
  status: MatchStatus;
  best: Candidate | null;
  candidates: Candidate[];
}

const AUTO_ACCEPT = 0.8;
const MIN_SCORE = 0.45;
const AMBIGUITY_MARGIN = 0.08;
const CONTENDER_GAP = 0.15;

/**
 * Fuzzy matcher over customers / suppliers / products. Exact (normalised) name or
 * alias hits win outright; otherwise fuse.js scores decide, and near-ties are
 * reported as ambiguous so the user picks (e.g. two "Sharma"s).
 */
export class EntityMatcher {
  private readonly fuse: Fuse<{ target: MatchTarget; key: string; raw: string }>;
  private readonly entries: { target: MatchTarget; key: string; raw: string }[];

  constructor(targets: MatchTarget[]) {
    this.entries = targets.flatMap((t) =>
      [t.name, ...t.aliases].map((k) => ({ target: t, key: normalizeName(k), raw: cleanName(k) })).filter((e) => e.key),
    );
    this.fuse = new Fuse(this.entries, { keys: ['key'], includeScore: true, threshold: 0.5, ignoreLocation: true });
  }

  match(query: string | null | undefined): EntityMatch {
    const q = normalizeName(query ?? '');
    const rawQ = cleanName(query ?? '');
    if (!q) return { query: query ?? '', status: 'not_found', best: null, candidates: [] };

    const scores = new Map<string, Candidate>();
    const keep = (t: MatchTarget, score: number) => {
      const prev = scores.get(t.id);
      if (!prev || prev.score < score) scores.set(t.id, { id: t.id, name: t.name, subtitle: t.subtitle, score: Math.round(score * 100) / 100 });
    };

    for (const e of this.entries) {
      // Exact name/alias as spoken ("Sharma ji") is decisive; the same words without the
      // honorific ("Sharma") are strong but can tie with another customer's surname.
      if (e.raw === rawQ) keep(e.target, 1);
      else if (e.key === q) keep(e.target, 0.9);
      else if (q.length >= 3 && (` ${e.key} `.includes(` ${q} `) || ` ${q} `.includes(` ${e.key} `))) keep(e.target, 0.85);
    }
    // Fuzzy-only hits (speech noise like "sarma") are capped so they never outrank an exact/whole-word hit.
    for (const r of this.fuse.search(q, { limit: 8 })) keep(r.item.target, Math.min(AUTO_ACCEPT, 1 - (r.score ?? 1)));

    const candidates = [...scores.values()].filter((c) => c.score >= MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, 5);
    const [first, second] = candidates;
    if (!first) return { query: query ?? '', status: 'not_found', best: null, candidates: [] };

    const tie = second && first.score - second.score < AMBIGUITY_MARGIN;
    const status: MatchStatus = first.score >= AUTO_ACCEPT && !tie ? 'matched' : 'ambiguous';
    // Offer only real contenders: names close to the best score (two Sharmas), not every weak fuzzy hit.
    const contenders = candidates.filter((c) => c.score >= first.score - CONTENDER_GAP);
    return { query: query ?? '', status, best: first, candidates: contenders };
  }

  /** Finds known names mentioned anywhere in free text (used by the offline parser). */
  findMentions(text: string): { target: MatchTarget; key: string; index: number; length: number }[] {
    const hay = ` ${normalizeName(text)} `;
    const found: { target: MatchTarget; key: string; index: number; length: number }[] = [];
    const sorted = [...this.entries].sort((a, b) => b.key.length - a.key.length);
    const taken: [number, number][] = [];
    for (const e of sorted) {
      if (e.key.length < 3) continue;
      const idx = hay.indexOf(` ${e.key} `);
      if (idx === -1) continue;
      const start = idx + 1;
      const end = start + e.key.length;
      if (taken.some(([s, f]) => start < f && end > s)) continue;
      if (found.some((f) => f.target.id === e.target.id)) continue;
      taken.push([start, end]);
      found.push({ target: e.target, key: e.key, index: start, length: e.key.length });
    }
    return found.sort((a, b) => a.index - b.index);
  }
}
