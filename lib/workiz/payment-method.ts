/**
 * How the customer paid, read from the text Workiz sends. Pure: no I/O.
 *
 * Verified against live webhook payloads (Sept–Nov 2026): a payment record is
 *   { id, type, amount, tipAmount, status, date, estimateId, confirmationCode, collectedById }
 * and a card payment arrives as `type: "charge"` (newer events) or `type: "Credit charge"`
 * (older events); Workiz's `addPayment` enum calls the same thing `credit`. All three are one
 * method here: Credit Card, the only method that carries the 3.5% deduction.
 *
 * Matching is by whole words against a closed vocabulary, never by substring. A text is a
 * method only when EVERY word in it belongs to that method, so "Charge" is a card payment while
 * "Chargeback", "Charge refund", "Credit memo" and "Store credit" are not recognised and hold
 * the payout for review instead of being read as a successful card payment.
 */

export const CREDIT_CARD_LABEL = "Credit Card"

export type PaymentMethodClass = {
  /** Display label: Credit Card, Cash, Check, Zelle, Venmo, Cash App, Bank transfer; the original text when not recognised. */
  label: string
  isCard: boolean
  /** False when the text is not a method we can place on the card / non-card side. */
  known: boolean
}

/** Methods an admin may confirm by hand; mirrors what the Workiz Payments tab can show. */
export const MANUAL_PAYMENT_METHODS = ["Cash", "Check", "Zelle", "Venmo", "Cash App", "Bank transfer", CREDIT_CARD_LABEL] as const
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number]

type MethodRule = {
  label: string
  isCard: boolean
  /** A text needs at least one of these words to be this method. */
  words: readonly string[]
  /** Words that may accompany them without changing the method. */
  companions?: readonly string[]
  /** Whole texts that are this method although they contain none of `words`. */
  phrases?: readonly string[]
}

const METHOD_RULES: readonly MethodRule[] = [
  {
    label: CREDIT_CARD_LABEL,
    isCard: true,
    words: ["credit", "charge", "card", "debit", "cc", "visa", "mastercard", "amex", "discover", "stripe"],
    companions: ["master", "american", "express", "workiz", "pay"],
    phrases: ["workiz pay", "american express"],
  },
  { label: "Cash App", isCard: false, words: ["cashapp"] },
  { label: "Check", isCard: false, words: ["check", "cheque", "checks"], companions: ["paper", "personal", "business"] },
  { label: "Cash", isCard: false, words: ["cash"] },
  { label: "Zelle", isCard: false, words: ["zelle"] },
  { label: "Venmo", isCard: false, words: ["venmo"] },
  { label: "Bank transfer", isCard: false, words: ["ach", "wire", "bank", "echeck"], companions: ["transfer", "workiz", "pay", "account", "direct", "deposit"] },
]

/** Words that describe a payment without naming how it was made ("Credit (offline)", "Check payment"). */
const NEUTRAL_WORDS = new Set(["payment", "payments", "offline", "online", "manual", "paid", "by", "via", "ending", "in", "no", "number", "type", "method"])

/** A check number or the last four digits of a card ("Check 1042", "Visa x4242"). */
const isReferenceNumber = (word: string) => /^x*\d+$/.test(word)

/** Lower case, punctuation and repeated spaces collapsed to single spaces, trimmed. */
export function normalizeMethodText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\bcash app\b/g, "cashapp")
    .replace(/\be check\b/g, "echeck")
    .replace(/\bcharged? back\b/g, "chargeback")
}

const displayText = (value: string) => {
  const text = value.trim().replace(/\s+/g, " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Extra card words from Admin → Workiz settings. A single word joins the card vocabulary; a
 * longer entry must match the whole text. Neither is ever matched as a substring.
 */
function cardVocabulary(cardKeywords: readonly string[]): { words: Set<string>; phrases: Set<string> } {
  const rule = METHOD_RULES[0]
  const words = new Set(rule.words)
  const phrases = new Set(rule.phrases ?? [])
  for (const keyword of cardKeywords) {
    const normalized = normalizeMethodText(keyword)
    if (!normalized) continue
    if (normalized.includes(" ")) phrases.add(normalized)
    else words.add(normalized)
  }
  return { words, phrases }
}

export function classifyPaymentMethod(method: string | null | undefined, cardKeywords: readonly string[] = []): PaymentMethodClass {
  const original = (method ?? "").trim()
  const normalized = normalizeMethodText(original)
  if (!normalized) return { label: "Unknown method", isCard: false, known: false }

  const tokens = normalized.split(" ").filter((word) => !isReferenceNumber(word))
  const card = cardVocabulary(cardKeywords)
  const matches: MethodRule[] = []
  for (const rule of METHOD_RULES) {
    const words = rule.isCard ? card.words : new Set(rule.words)
    const phrases = rule.isCard ? card.phrases : new Set(rule.phrases ?? [])
    if (phrases.has(tokens.join(" "))) {
      matches.push(rule)
      continue
    }
    const companions = new Set(rule.companions ?? [])
    const named = tokens.some((word) => words.has(word))
    const onlyThisMethod = tokens.every((word) => words.has(word) || companions.has(word) || NEUTRAL_WORDS.has(word))
    if (named && onlyThisMethod) matches.push(rule)
  }
  // Two methods claiming the same text is not a recognition; it is held like any unknown text.
  if (matches.length !== 1) return { label: displayText(original), isCard: false, known: false }
  return { label: matches[0].label, isCard: matches[0].isCard, known: true }
}

/** The option an admin form should show for a stored method, or "" when it is not one we recognise. */
export function manualMethodFor(method: string | null | undefined, cardKeywords: readonly string[] = []): ManualPaymentMethod | "" {
  const cls = classifyPaymentMethod(method, cardKeywords)
  return cls.known && (MANUAL_PAYMENT_METHODS as readonly string[]).includes(cls.label) ? (cls.label as ManualPaymentMethod) : ""
}

/** Fields of a Workiz payment record that can say how it was paid, most specific last. */
const METHOD_FIELDS = ["type", "Type", "paymentType", "payment_type", "PaymentType", "method", "Method", "paymentMethod", "payment_method", "PaymentMethod", "methodType", "method_type", "subType", "sub_type"] as const
/** Inside a nested method object (`paymentMethod: { type: "card", brand: "visa" }`). */
const NESTED_METHOD_FIELDS = ["type", "name", "method", "brand"] as const

const text = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null
  const s = String(value).trim()
  return s.length ? s : null
}

export type ResolvedPaymentMethod = PaymentMethodClass & {
  /** Exactly what Workiz sent, kept for troubleshooting. Several fields are joined in payload order. */
  original: string
}

/**
 * Read the method from a Workiz payment record. Workiz normally puts it in `type`; when it is
 * split across fields ("Credit" in one, "Charge" in another) the parts are read together. Parts
 * that name different methods, or a part that is not a method word at all (a refund, a
 * chargeback), leave the record unrecognised rather than letting one field win.
 */
export function resolvePaymentMethod(record: Record<string, unknown> | null | undefined, cardKeywords: readonly string[] = []): ResolvedPaymentMethod {
  const parts: string[] = []
  const seen = new Set<string>()
  const add = (value: unknown) => {
    const part = text(value)
    if (!part) return
    const key = normalizeMethodText(part)
    if (!key || seen.has(key)) return
    seen.add(key)
    parts.push(part)
  }
  for (const field of METHOD_FIELDS) {
    const value = record?.[field]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of NESTED_METHOD_FIELDS) add((value as Record<string, unknown>)[nested])
    } else {
      add(value)
    }
  }
  const original = parts.join(" ")
  return { ...classifyPaymentMethod(original, cardKeywords), original }
}

export type PaymentOutcome =
  /** Money the business received (or a record with no status at all, as manual entries are). */
  | "received"
  /** The charge never went through: declined, failed, cancelled, voided. */
  | "failed"
  /** Money that came in and went back: refunded, charged back, disputed, returned. */
  | "reversed"

const STATUS_FIELDS = ["status", "Status", "state", "paymentStatus", "payment_status"] as const
const FAILED_WORDS = new Set(["failed", "failure", "declined", "canceled", "cancelled", "void", "voided", "rejected", "expired", "error"])
const REVERSED_WORDS = new Set(["refund", "refunded", "refunds", "chargeback", "chargebacks", "reversed", "reversal", "disputed", "dispute", "returned", "bounced"])

/**
 * Whether a Workiz payment record is money actually received. Only an explicit failure or
 * reversal disqualifies it: live card payments say "succeeded", while cash and check records
 * may carry no status or "pending" and are still payments. The method fields are checked too,
 * because a refund can arrive as its own record with `type: "refund"`.
 */
export function paymentOutcome(record: Record<string, unknown> | null | undefined): PaymentOutcome {
  const words: string[] = []
  for (const field of [...STATUS_FIELDS, ...METHOD_FIELDS]) {
    const value = text(record?.[field])
    if (value) words.push(...normalizeMethodText(value).split(" "))
  }
  if (words.some((word) => REVERSED_WORDS.has(word))) return "reversed"
  for (const field of STATUS_FIELDS) {
    const value = text(record?.[field])
    if (value && normalizeMethodText(value).split(" ").some((word) => FAILED_WORDS.has(word))) return "failed"
  }
  return "received"
}
