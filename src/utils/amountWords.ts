/** Bill totals in words, Indian style (lakh / crore), in English and Hindi. Input is paise. */

const EN_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const EN_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

// Hindi has an irregular word for every number up to 99.
const HI_0_99 = (
  ' एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस ' +
  'इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस ' +
  'इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरेपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ ' +
  'इकसठ बासठ तिरेसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी अस्सी ' +
  'इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानबे बानबे तिरानबे चौरानबे पंचानबे छियानबे सत्तानबे अट्ठानबे निन्यानबे'
).split(' ');

const enBelow100 = (n: number): string => (n < 20 ? EN_ONES[n]! : `${EN_TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + EN_ONES[n % 10] : ''}`);

/** Splits a whole number into Indian groups: crore, lakh, thousand, hundred, rest. */
function groups(n: number): { crore: number; lakh: number; thousand: number; hundred: number; rest: number } {
  return {
    crore: Math.floor(n / 1e7),
    lakh: Math.floor((n % 1e7) / 1e5),
    thousand: Math.floor((n % 1e5) / 1e3),
    hundred: Math.floor((n % 1e3) / 100),
    rest: n % 100,
  };
}

function enWords(n: number): string {
  if (n === 0) return 'Zero';
  const g = groups(n);
  return [
    g.crore ? `${enWords(g.crore)} Crore` : '',
    g.lakh ? `${enBelow100(g.lakh)} Lakh` : '',
    g.thousand ? `${enBelow100(g.thousand)} Thousand` : '',
    g.hundred ? `${EN_ONES[g.hundred]} Hundred` : '',
    g.rest ? enBelow100(g.rest) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function hiWords(n: number): string {
  if (n === 0) return 'शून्य';
  const g = groups(n);
  return [
    g.crore ? `${hiWords(g.crore)} करोड़` : '',
    g.lakh ? `${HI_0_99[g.lakh]} लाख` : '',
    g.thousand ? `${HI_0_99[g.thousand]} हज़ार` : '',
    g.hundred ? `${HI_0_99[g.hundred]} सौ` : '',
    g.rest ? HI_0_99[g.rest]! : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** 123450 -> "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only". */
export function amountInWordsEn(paise: number): string {
  const p = Math.max(0, Math.round(paise));
  const rupees = Math.floor(p / 100);
  const ps = p % 100;
  return `Rupees ${enWords(rupees)}${ps ? ` and ${enBelow100(ps)} Paise` : ''} Only`;
}

/** 123450 -> "एक हज़ार दो सौ चौंतीस रुपये पचास पैसे मात्र". */
export function amountInWordsHi(paise: number): string {
  const p = Math.max(0, Math.round(paise));
  const rupees = Math.floor(p / 100);
  const ps = p % 100;
  return `${hiWords(rupees)} रुपये${ps ? ` ${HI_0_99[ps]} पैसे` : ''} मात्र`;
}
