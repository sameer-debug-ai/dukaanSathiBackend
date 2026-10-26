import type { Lang } from './ai.service';

/**
 * Which language to answer in: the one the shopkeeper spoke, not the app's UI language.
 * Devanagari is Hindi; Roman text is Hindi when it reads like Hinglish ("Sharma ji ka kitna
 * udhaar hai") and English when English words dominate ("how much does Sharma ji owe").
 */

const HINDI_WORDS = new Set([
  'ka', 'ki', 'ke', 'ko', 'ne', 'se', 'me', 'mein', 'mai', 'hai', 'hain', 'tha', 'thi', 'the', 'hua', 'hui', 'hue',
  'kitna', 'kitni', 'kitne', 'kya', 'kaun', 'kaunsa', 'kaunse', 'kab', 'kahan', 'kaise', 'kyu', 'kyun',
  'mera', 'meri', 'mere', 'apna', 'apni', 'apne', 'aaj', 'kal', 'parso', 'abhi', 'is', 'iss', 'us', 'uss',
  'diya', 'diye', 'di', 'do', 'de', 'dena', 'liya', 'liye', 'li', 'lo', 'becha', 'beche', 'bechi', 'bika', 'biki', 'bike',
  'bacha', 'bachi', 'bache', 'baaki', 'baki', 'karo', 'kardo', 'krdo', 'kar', 'batao', 'bataiye', 'dikhao',
  'jodo', 'jod', 'badhao', 'ghatao', 'khatam', 'sara', 'saara', 'pura', 'poora', 'aur', 'ya', 'nahi', 'nahin', 'wala', 'wale',
  'rupay', 'rupaye', 'hafte', 'mahine', 'bikri', 'saman', 'samaan', 'hisaab', 'hisab', 'chuka', 'chukta',
]);
// "ji", "bhaiya", "udhaar" show up in English sentences too ("add 500 to Sharma ji's udhaar"),
// so they are left out of both lists.

const ENGLISH_WORDS = new Set([
  'what', 'which', 'who', 'how', 'much', 'many', 'is', 'are', 'was', 'were', 'does', 'do', 'did', 'has', 'have', 'had',
  'the', 'a', 'an', 'of', 'to', 'for', 'from', 'in', 'on', 'my', 'me', 'i', 'and', 'or', 'not', 'any', 'all',
  'today', 'yesterday', 'week', 'month', 'this', 'last', 'show', 'tell', 'give', 'gave', 'paid', 'pay', 'add', 'added',
  'sold', 'sell', 'sale', 'sales', 'bought', 'buy', 'stock', 'left', 'out', 'low', 'owe', 'owes', 'due', 'balance',
  'items', 'products', 'customer', 'supplier', 'received', 'please', 'clear', 'cleared', 'entire', 'whole', 'full',
]);

export function detectReplyLang(text: string, fallback: Lang): Lang {
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let hi = 0;
  let en = 0;
  for (const w of words) {
    // Words in both lists ("do", "me", "is") say nothing either way.
    const h = HINDI_WORDS.has(w);
    const e = ENGLISH_WORDS.has(w);
    if (h && !e) hi++;
    else if (e && !h) en++;
  }
  if (hi === en) return fallback;
  return hi > en ? 'hi' : 'en';
}
