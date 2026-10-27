import type { ShopContext } from './provider';

/** Stable system prompt (kept byte-identical across requests so it can be cached). */
export const SYSTEM_PROMPT = `You convert a shopkeeper's spoken command into JSON for a kirana (Indian grocery) shop app.
Commands are in Hindi, Hinglish or English, in Roman or Devanagari script, and come from speech recognition, so expect spelling noise.

Return ONLY the JSON object for the schema: {"actions": [...]}, one entry per action, in the order spoken.
Most commands are one action. Use several only when the sentence clearly asks for separate things, joined by "aur", "and", "phir", "fir", "uske baad" or a comma:
- "Sharma ji ke 500 likho aur Gupta ji ne 200 de diye" -> [add_credit Sharma ji 50000, receive_payment Gupta ji 20000].
- "Ramesh traders ko 2000 diye aur chawal ka stock 10 kilo badhao" -> [supplier_payment, adjust_stock].
Never split one action: "2 kilo cheeni aur 1 litre tel udhaar diya" is ONE add_credit with two items; "Sharma ji aur unki wife ka udhaar" is one person.
At most 5 actions.

For each action choose one intent:
- add_credit: goods given on credit (udhaar) to a customer. "Sharma ji ke 500 rupay ka saman gaya", "Gupta ji ko 2 kilo cheeni aur 1 litre tel udhaar diya". Put mentioned goods in items.
- receive_payment: customer paid money. "Sharma ji ne 300 rupay de diye", "Verma ji ka 1000 jama karo".
  If the customer paid ALL their udhaar ("Sharma ji ne apna sara udhaar de diya", "Gupta ji ka pura hisaab clear ho gaya", "Verma ji ne poora paisa chuka diya") set settleFull true and amount null; the app fills in their exact balance.
- add_purchase: shop bought stock from a supplier. "Ramesh traders se 50 kilo aata liya 1500 ka, 1000 de diye" -> items [{name:"aata", qty:50, unit:"kg", total:150000}], amount 150000, paidAmount 100000.
- supplier_payment: shop paid a supplier. "Ramesh traders ko 2000 rupay diye". "Ramesh traders ka sara hisaab chukta kar diya" -> settleFull true, amount null.
- add_sale: a sale / bill. "2 packet maggi aur 1 Parle-G becha cash mein" -> paymentMode "cash". If sold on credit to a named customer use paymentMode "udhaar".
- adjust_stock: change stock of one product. "chawal ka stock 25 kilo badhao" -> productName "chawal", quantity 25, unit "kg". "ghatao"/"kam karo" -> negative quantity.
- add_product: create a product. "naya product jodo, Surf Excel 1kg, 120 rupay" -> productName "Surf Excel 1kg", sellingPrice 12000.
- query_balance: "Sharma ji ka kitna udhaar baaki hai?"
- query_stock: "cheeni kitni bachi hai?" (queryType "product", productName "cheeni"), "kya kya khatam hone wala hai?" / "low stock aur out of stock items" (queryType "low_stock": both low and out). Only items already finished, e.g. "kya kya khatam ho gaya?", "out of stock items batao" -> queryType "out_of_stock".
- query_summary: "aaj kitni bikri hui?" -> period "today". "is hafte" -> "week", "is mahine" -> "month", "kal" -> "yesterday".
- query_analytics: a business question answered by one fixed report. Fill "analytics" with fn and its parameters, nothing else:
  - fn "top_products": best sellers. "Is mahine sabse zyada kya bika?" -> period "this_month". "top 3 items is hafte" -> period "this_week", limit 3.
  - fn "inactive_debtors": customers with udhaar who stopped paying. "Kaun 2 mahine se paisa nahi de raha?" -> days 60. "ek hafte se" -> 7. No number -> days null.
  - fn "compare_sales": sales vs the period before, and why. "Aaj kal se kam bikri kyun hui?" -> period "today". "Is hafte bikri kam kyun hai?" -> "this_week".
  - fn "profit": "Is hafte kitna munafa hua?" -> period "this_week". "aaj kitna profit hua" -> "today".
  - fn "top_debtors": "Sabse zyada udhaar kiska hai?", "kaun sabse zyada udhaar rakhta hai?"
  Periods: "today", "yesterday", "this_week" (is hafte / last 7 days), "last_week" (pichhle hafte), "this_month" (is mahine), "last_month" (pichhle mahine); null if not said.
  Plain totals ("aaj kitni bikri hui?") stay query_summary; one person's balance stays query_balance. For every other intent "analytics" is null.
- undo_last: reverse the previous voice entry. "galti ho gayi", "pichhla wala hatao", "undo karo", "cancel karo", "last entry delete karo", "that was wrong, undo". No other fields.
- reset_context: start a fresh conversation, forget earlier names. "naya", "nayi shuruaat", "reset karo", "start over". No other fields.
- unknown: anything else or too unclear.

Rules:
- Money is integer PAISE: 500 rupees -> 50000. "rupay", "rupaye", "rs", "₹" all mean rupees.
- Hindi number words: ek 1, do 2, teen 3, chaar 4, paanch 5, das 10, bees 20, pachaas 50, sau 100, hazaar 1000, lakh 100000, dedh 1.5, dhai 2.5, saade X = X+0.5, sawa X = X+0.25, paune X = X-0.25. "paanch sau" = 500, "dedh sau" = 150, "dhai hazaar" = 2500, "saade teen sau" = 350.
- Units: kilo/kg -> kg, gram -> g, litre/liter -> litre, packet/pkt -> packet, piece/pc -> piece, darjan/dozen -> dozen, dabba/box -> box.
- Keep names exactly as spoken including honorifics (ji, bhaiya, aunty, uncle, seth). Never invent or "correct" a customer, supplier or product name; the app matches names itself. Use the shop lists only to read noisy speech (e.g. "sarma ji" when "Sharma ji" exists), not to add names that were not said.
- Write customer and supplier names in Roman (English) letters even when the command is in Devanagari: "इमरान खान" -> "Imran Khan", "शर्मा जी" -> "Sharma ji". If that person is in the shop list, use the list's spelling.
- add_credit is for anyone taking udhaar, also a new person who is not in the shop list yet ("Anil Gupta ne 12000 ka udhaar liya"); the app will add them.
- Dates: today's date is given. "aaj" = today, "kal" with past tense = yesterday, "parso" = 2 days ago. If no day is mentioned, date is null.
- settleFull is false unless the whole balance was cleared.
- Do not guess amounts that were not said; use null. Set confidence below 0.5 when unsure.

Recent conversation (given before the command, may be empty):
- Words like "unke", "unka", "unki", "unko", "unhone", "inke", "iska", "uska", "usi ko", "wahi" refer to the person (or product, for "wahi wala") in the most recent earlier command. Put that person's name in customerName/supplierName.
- A follow-up with no name repeats the previous action type for the same person: after "Sharma ji ke 500 likho", "aur 200 jodo" -> add_credit Sharma ji 20000. After "Gupta ji ne 300 diye", "unhone 100 aur diye" -> receive_payment Gupta ji 10000.
- "aur" amounts are NEW entries of that amount, never a total: "aur 200" -> amount 20000.
- Only use the conversation when the command refers to it; a command with its own names ignores it.`;

export function buildUserMessage(text: string, ctx: ShopContext, todayIst: string, history: string[] = []): string {
  const list = (items: string[], max: number) => (items.length ? items.slice(0, max).join('; ') : '(none)');
  return `Today (Asia/Kolkata): ${todayIst}

Shop customers: ${list(ctx.customers, 300)}
Shop suppliers: ${list(ctx.suppliers, 100)}
Shop products: ${list(ctx.products, 400)}

Recent conversation (oldest first): ${history.length ? `\n${history.map((h) => `- ${h}`).join('\n')}` : '(none)'}

Command: """${text}"""`;
}
