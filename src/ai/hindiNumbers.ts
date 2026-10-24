/**
 * Converts spoken Hindi / Hinglish / English number words (Roman or Devanagari)
 * into digits: "paanch sau" -> 500, "dedh sau" -> 150, "dhai hazaar" -> 2500,
 * "saade teen sau" -> 350, "do hazaar paanch sau" -> 2500.
 */

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

const UNITS: Record<string, number> = {
  // Roman Hindi
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, paach: 5, chhe: 6, chhah: 6, chah: 6, che: 6,
  saat: 7, sat: 7, aath: 8, ath: 8, nau: 9, das: 10, dus: 10, gyarah: 11, gyara: 11, barah: 12, bara: 12, terah: 13,
  chaudah: 14, pandrah: 15, solah: 16, satrah: 17, atharah: 18, unnis: 19, bees: 20, bis: 20, pachees: 25, pachchis: 25,
  tees: 30, tis: 30, chalees: 40, chalis: 40, pachaas: 50, pachas: 50, sattar: 70, assi: 80, nabbe: 90,
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // Devanagari
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  'बीस': 20, 'पच्चीस': 25, 'तीस': 30, 'चालीस': 40, 'पचास': 50, 'साठ': 60, 'सत्तर': 70, 'अस्सी': 80, 'नब्बे': 90,
};

/** Fractional words that stand alone or scale the following multiplier. */
const FRACTIONS: Record<string, number> = {
  dedh: 1.5, dedhh: 1.5, derh: 1.5, 'डेढ़': 1.5, 'डेढ': 1.5,
  dhai: 2.5, dhaai: 2.5, adhai: 2.5, 'ढाई': 2.5,
  aadha: 0.5, adha: 0.5, aadhi: 0.5, half: 0.5, 'आधा': 0.5, 'आधी': 0.5,
};

/** Prefix modifiers: "saade teen" = 3.5, "sawa do" = 2.25, "paune teen" = 2.75. */
const PREFIX: Record<string, number> = {
  saade: 0.5, sade: 0.5, saadhe: 0.5, 'साढ़े': 0.5, 'साढे': 0.5,
  sawa: 0.25, sava: 0.25, 'सवा': 0.25,
  paune: -0.25, 'पौने': -0.25,
};

const HUNDRED = new Set(['sau', 'so', 'saw', 'hundred', 'सौ']);
const THOUSAND: Record<string, number> = {
  hazaar: 1000, hazar: 1000, hajar: 1000, hajaar: 1000, thousand: 1000, k: 1000, 'हज़ार': 1000, 'हजार': 1000,
  lakh: 100000, lac: 100000, 'लाख': 100000,
};

const isNumeric = (t: string) => /^\d+(\.\d+)?$/.test(t);

const AMBIGUOUS = new Set(['do', 'so', 'saw', 'sat', 'tin', 'k', 'ek', 'che', 'bis', 'ath', 'tis']);
const QUANTITY_FOLLOWERS =
  /^(kilo|kg|kilogram|gram|gm|g|litre|liter|ltr|ml|packet|packets|pkt|piece|pieces|pc|pcs|dozen|darjan|box|dabba|dabbe|bottle|bori|rupay|rupaye|rupee|rupees|rs|₹|ka|ki|ke)$/;

export function devanagariToAsciiDigits(text: string): string {
  return text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
}

function isNumberWord(t: string): boolean {
  return isNumeric(t) || t in UNITS || t in FRACTIONS || t in PREFIX || HUNDRED.has(t) || t in THOUSAND;
}

/** Parses a run of number tokens. Returns null when the run is not a number. */
export function parseNumberTokens(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  let pendingPrefix = 0;
  let seen = false;

  for (const t of tokens) {
    if (t in PREFIX) {
      pendingPrefix = PREFIX[t]!;
      continue;
    }
    let unit: number | undefined;
    if (isNumeric(t)) unit = Number(t);
    else if (t in UNITS) unit = UNITS[t];
    else if (t in FRACTIONS) unit = FRACTIONS[t];

    if (unit !== undefined) {
      current += unit + pendingPrefix;
      pendingPrefix = 0;
      seen = true;
    } else if (HUNDRED.has(t)) {
      // "sawa sau" = 125: a dangling prefix applies to an implicit 1.
      current = ((current || 1) + pendingPrefix) * 100;
      pendingPrefix = 0;
      seen = true;
    } else if (t in THOUSAND) {
      total += ((current || 1) + pendingPrefix) * THOUSAND[t]!;
      current = 0;
      pendingPrefix = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + current : null;
}

/**
 * Replaces spoken numbers in free text with digits, keeping other words.
 * "Gupta ji ko do kilo cheeni" -> "Gupta ji ko 2 kilo cheeni".
 */
export function normalizeSpokenNumbers(text: string): string {
  const cleaned = devanagariToAsciiDigits(text)
    .replace(/₹\s*/g, '₹ ')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/(\d)(k)\b/gi, '$1 k');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];

  const flush = (next?: string) => {
    if (!run.length) return;
    // A lone "do"/"so"/"ek"... is often a verb or article ("de do", "so gaya", "ek baat"),
    // so only treat it as a number when a unit or money word follows ("do kilo", "ek packet").
    const ambiguousAlone =
      run.length === 1 &&
      AMBIGUOUS.has(run[0]!) &&
      !(next && QUANTITY_FOLLOWERS.test(next.toLowerCase()));
    const value = ambiguousAlone ? null : parseNumberTokens(run);
    if (value === null) out.push(...run);
    else out.push(String(Math.round(value * 1000) / 1000));
    run = [];
  };

  for (const tok of tokens) {
    const bare = tok.toLowerCase().replace(/[,.!?]+$/, '');
    if (isNumberWord(bare)) {
      run.push(bare);
    } else {
      flush(bare);
      out.push(tok);
    }
  }
  flush();
  return out.join(' ');
}
