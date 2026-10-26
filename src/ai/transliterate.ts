/**
 * Devanagari -> Hinglish (Roman) transliteration for the offline parser.
 * Chrome's hi-IN speech recognition returns "शर्मा जी के उधार में 500 ऐड कर दो",
 * while the parser and the customer list speak "sharma ji ke udhar men 500 add kardo".
 * Spelling follows common Hinglish (आ -> "a", व -> "v") rather than strict ISO.
 */

const CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  // Precomposed nukta forms.
  'क़': 'k', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y',
};

/** Consonant + combining nukta (U+093C). */
const NUKTA: Record<string, string> = { k: 'k', kh: 'kh', g: 'g', j: 'z', d: 'r', dh: 'rh', ph: 'f', y: 'y' };

const MATRAS: Record<string, string> = {
  'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॅ': 'e', 'ॉ': 'o',
};

const VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};

const VIRAMA = '्';
const NUKTA_SIGN = '़';

/** English loanwords as Chrome spells them in Devanagari, after transliteration. */
const LOANWORDS: Record<string, string> = {
  aid: 'add', ed: 'add', aidd: 'add',
  jor: 'jod', joro: 'jodo', jore: 'jode', jorna: 'jodna',
  stok: 'stock', bil: 'bill', sel: 'sale', pement: 'payment', bailens: 'balance', kredit: 'credit',
  khatm: 'khatam', kliyar: 'clear', klier: 'clear', setal: 'settle', ful: 'full', prodakt: 'product', prodkt: 'product', yupiai: 'upi', onlain: 'online', kesh: 'cash', kaish: 'cash',
  aut: 'out', oph: 'of', aitam: 'item', aitams: 'items', paiket: 'packet', paket: 'packet', bred: 'bread', litar: 'litre',
  // Common Hinglish spellings, so they match how products/aliases are usually typed.
  aj: 'aaj', dudh: 'doodh', chini: 'cheeni', chaval: 'chawal', ata: 'aata',
  kainsal: 'cancel', kaisal: 'cancel', kensal: 'cancel', andu: 'undo', anadu: 'undo', dilit: 'delete', diliit: 'delete', laist: 'last', lasat: 'last'
};

interface Unit {
  c: string;
  v: string;
  inherent: boolean;
  glide?: boolean;
}

function wordToRoman(word: string): string {
  const units: Unit[] = [];
  for (const ch of word) {
    const last = units[units.length - 1];
    if (CONSONANTS[ch] !== undefined) units.push({ c: CONSONANTS[ch]!, v: 'a', inherent: true });
    else if (ch === NUKTA_SIGN && last) last.c = NUKTA[last.c] ?? last.c;
    else if (MATRAS[ch] !== undefined && last) Object.assign(last, { v: MATRAS[ch], inherent: false });
    else if (ch === VIRAMA && last) Object.assign(last, { v: '', inherent: false });
    else if (VOWELS[ch] !== undefined) {
      // "दिए" -> "diye", "रुपए" -> "rupaye": a vowel after a vowel gets a glide.
      const glide = last && last.v && (ch === 'ए' || ch === 'ऐ') ? 'y' : '';
      units.push({ c: glide, v: VOWELS[ch]!, inherent: false, glide: !!glide });
    } else if ((ch === 'ं' || ch === 'ँ') && last) Object.assign(last, { v: last.v + 'n', inherent: false });
    else if (ch === 'ः' && last) last.v += 'h';
  }
  // Schwa deletion: drop a word-final inherent "a" ("udhar", not "udhara"), then a medial
  // one between a vowel and a full syllable ("kitna", not "kitana").
  const n = units.length;
  if (n > 1 && units[n - 1]!.inherent) units[n - 1]!.v = '';
  for (let i = n - 2; i >= 1; i--) {
    const u = units[i]!;
    const prev = units[i - 1]!;
    const next = units[i + 1]!;
    if (u.inherent && prev.v && next.c && next.v && !next.glide) u.v = '';
  }
  const roman = units.map((u) => u.c + u.v).join('');
  return LOANWORDS[roman] ?? roman;
}

/** Transliterates every Devanagari word; digits, Roman text and punctuation pass through. */
export function devanagariToRoman(text: string): string {
  return text.replace(/[ऀ-ॣ॰-ॿ]+/g, (w) => wordToRoman(w)).replace(/[।॥]/g, '.');
}
