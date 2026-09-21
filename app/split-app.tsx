"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CircleDollarSign, Download, LogIn, LogOut, Pencil, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { browserLocalPersistence, GoogleAuthProvider, onAuthStateChanged, setPersistence, signInWithPopup, signOut, type User as FirebaseUser } from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { auth, db } from "@/lib/firebase";

type Friend = { id: string; name: string };
type SplitMethod = "equal" | "shares" | "percentage" | "exact";
type SplitLine = { friendId: string; friendName: string; amount: number };
type Expense = { id: string; name: string; description: string; price: number; currency: string; date: string; payerId: string; payerName: string; method: SplitMethod; splits: SplitLine[]; splitInputs?: Record<string, number | string> };
type Group = { id: string; name: string; friends: Friend[]; expenses: Expense[]; primaryCurrency?: string; exchangeRates?: Record<string, string>; settleInPrimary?: boolean };
type AppData = { version: 1; groups: Group[]; activeGroupId: string };
type Draft = { name: string; description: string; price: string; currency: string; otherCurrency: string; date: string; payerId: string; method: SplitMethod; selected: string[]; values: Record<string, string> };
type Balance = { id: string; name: string; amount: number; removed: boolean };
type Settlement = { from: string; to: string; amount: number };

const currencies = ["SGD", "MYR", "USD", "EUR", "GBP", "JPY", "TWD", "AUD", "Other"];
const symbols: Record<string, string> = { SGD: "S$", MYR: "RM", USD: "$", EUR: "€", GBP: "£", JPY: "¥", TWD: "NT$", AUD: "A$" };
const methods: { key: SplitMethod; label: string }[] = [
  { key: "equal", label: "Equally" }, { key: "shares", label: "Shares" },
  { key: "percentage", label: "Percentage" }, { key: "exact", label: "Exact amount" },
];
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);

const MAX_AMOUNT = 1_000_000_000_000;
function precision(code: string): number {
  if (!/^[A-Z]{3}$/.test(code)) return -1;
  try { return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return -1; }
}
function quantum(code: string): number { return precision(code) === 0 ? 100 : 1; }
function decimal(value: string): { n: bigint; d: bigint } | null {
  const text = value.trim();
  if (text.length > 40 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 12) return null;
  return { n: BigInt((whole || "0") + fraction), d: 10n ** BigInt(fraction.length) };
}
function parseAmount(value: string, code: string): number | null {
  const p = precision(code), valueParts = decimal(value);
  if (![0, 2].includes(p) || !valueParts) return null;
  const scaled = valueParts.n * 100n;
  if (scaled % valueParts.d !== 0n) return null;
  const amount = Number(scaled / valueParts.d);
  return Number.isSafeInteger(amount) && amount <= MAX_AMOUNT && amount % quantum(code) === 0 ? amount : null;
}
function validRate(value: string | undefined): boolean {
  const rate = decimal(value ?? "");
  return Boolean(rate && rate.n > 0n && rate.n <= rate.d * 1_000_000_000n);
}
// Largest-remainder apportionment. Ties follow saved participant order.
function allocate(total: number, weights: bigint[], unit = 1): number[] {
  const sum = weights.reduce((a,b) => a+b, 0n);
  if (!Number.isSafeInteger(total) || total < 0 || total % unit || sum <= 0n || weights.some(w => w < 0n)) throw new Error("Invalid allocation");
  const units = BigInt(total / unit);
  const rows = weights.map((w,i) => ({ i, base: units*w/sum, remainder: units*w%sum }));
  let left = units - rows.reduce((a,r) => a+r.base,0n);
  const ranked = [...rows].sort((a,b) => a.remainder === b.remainder ? a.i-b.i : a.remainder > b.remainder ? -1 : 1);
  for (const row of ranked) { if (!left) break; if (weights[row.i] > 0n) { row.base++; left--; } }
  return rows.map(r => Number(r.base)*unit);
}
function convertedAmount(amount: number, rateText: string, code: string): number {
  const rate = decimal(rateText);
  if (!rate || !validRate(rateText) || ![0,2].includes(precision(code))) throw new Error("Enter a valid rate and supported currency");
  const unit = quantum(code), numerator = BigInt(amount)*rate.n, denominator = rate.d*BigInt(unit);
  const result = Number((numerator*2n+denominator)/(2n*denominator))*unit;
  if (!Number.isSafeInteger(result) || result > MAX_AMOUNT) throw new Error("Converted amount is too large");
  return result;
}
function expenseIssue(expense: Expense): string | null {
  const validMoney = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_AMOUNT;
  if (![0,2].includes(precision(expense.currency))) return "Only currencies with zero or two decimal places are supported.";
  if (!validMoney(expense.price) || expense.price === 0 || !expense.splits.length || expense.splits.some(line => !validMoney(line.amount))) return "The saved amounts do not balance. Edit and save this expense.";
  if (expense.splits.reduce((sum,line) => sum+BigInt(line.amount),0n) !== BigInt(expense.price)) return "The saved amounts do not balance. Edit and save this expense.";
  if (expense.price % quantum(expense.currency) || expense.splits.some(line => line.amount % quantum(expense.currency))) return "This expense contains fractional currency units. Edit and save it to correct the split.";
  if (new Set(expense.splits.map(line => line.friendId)).size !== expense.splits.length) return "Duplicate participants need review.";
  return null;
}

const blankDraft = (): Draft => ({ name: "", description: "", price: "", currency: "SGD", otherCurrency: "", date: today(), payerId: "", method: "equal", selected: [], values: {} });
const draftFromExpense = (expense: Expense): Draft => {
  const isKnownCurrency = currencies.includes(expense.currency) && expense.currency !== "Other";
  let values: Record<string, string> = {};
  if (expense.method !== "equal") {
    if (expense.splitInputs) {
      values = Object.fromEntries(Object.entries(expense.splitInputs).map(([id, value]) => [id, String(value)]));
    } else if (expense.method === "percentage") {
      const percentages = allocate(100_000_000, expense.splits.map(line => BigInt(line.amount)));
      expense.splits.forEach((line, index) => { values[line.friendId] = (percentages[index] / 1_000_000).toFixed(6); });
    } else {
      values = Object.fromEntries(expense.splits.map((line) => [line.friendId, String(expense.method === "exact" ? line.amount / 100 : line.amount)]));
    }
  }
  return { name: expense.name, description: expense.description, price: String(expense.price / 100), currency: isKnownCurrency ? expense.currency : "Other", otherCurrency: isKnownCurrency ? "" : expense.currency, date: expense.date, payerId: expense.payerId, method: expense.method, selected: expense.splits.map((line) => line.friendId), values };
};
const newGroup = (name: string): Group => ({ id: uid(), name, friends: [], expenses: [], primaryCurrency: "SGD", exchangeRates: {}, settleInPrimary: false });
const initialData = (): AppData => { const first = newGroup("Weekend trip"), second = newGroup("Household"); return { version: 1, activeGroupId: first.id, groups: [first, second] }; };
const isAppData = (value: unknown): value is AppData => Boolean(value && typeof value === "object" && (value as AppData).version === 1 && Array.isArray((value as AppData).groups) && (value as AppData).groups.length && typeof (value as AppData).activeGroupId === "string");
const money = (amount: number, currency: string) => {
  const digits = precision(currency) === 0 && amount % 100 === 0 ? 0 : 2;
  return `${symbols[currency] ?? `${currency} `}${(amount / 100).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

function calculateSplits(draft: Draft, friends: Friend[]) {
  const code = draft.currency === "Other" ? draft.otherCurrency.trim().toUpperCase() : draft.currency;
  const invalid = (status: string) => ({ valid: false, lines: [] as SplitLine[], status });
  const total = parseAmount(draft.price, code);
  if (total === null || total <= 0) return invalid(precision(code) === 0 ? "Enter a positive whole-unit price." : "Enter a positive price with at most two decimal places; use a supported three-letter currency code.");
  const selected = draft.selected.map(id => friends.find(f => f.id === id));
  if (!selected.length || selected.some(f => !f) || new Set(draft.selected).size !== selected.length) return invalid("Select valid, unique participants.");
  let raw: number[], status: string;
  if (draft.method === "equal") {
    raw = allocate(total, selected.map(() => 1n), quantum(code));
    status = `${money(total,code)} across ${selected.length}`;
  } else if (draft.method === "exact") {
    const amounts = draft.selected.map(id => parseAmount(draft.values[id] || "0",code));
    if (amounts.some(value => value === null)) return invalid("Exact amounts must be nonnegative and use the currency’s precision.");
    raw = amounts as number[];
    const sum = raw.reduce((a,b) => a+b,0);
    status = `${money(sum,code)} of ${money(total,code)}`;
    if (sum !== total) return invalid(status + " — amounts must match exactly.");
  } else {
    const values = draft.selected.map(id => decimal(draft.values[id] || "0"));
    if (values.some(value => !value)) return invalid("Enter nonnegative numbers with up to 12 decimal places.");
    const parsed = values as { n: bigint; d: bigint }[];
    const denominator = parsed.reduce((d,value) => value.d > d ? value.d : d,1n);
    const weights = parsed.map(value => value.n*(denominator/value.d));
    const sum = weights.reduce((a,b) => a+b,0n);
    if (sum === 0n) return invalid("Enter at least one positive share.");
    if (draft.method === "percentage" && sum !== 100n*denominator) return invalid("Percentages must total exactly 100%.");
    raw = allocate(total,weights,quantum(code));
    status = draft.method === "percentage" ? "100% of 100%" : "Shares allocated proportionally";
  }
  return { valid:true, lines:selected.map((friend,i) => ({friendId:friend!.id,friendName:friend!.name,amount:raw[i]})), status };
}

function getBalances(group: Group, currency: string): Balance[] {
  const names = new Map<string, string>();
  group.friends.forEach((f) => names.set(f.id, f.name));
  group.expenses.filter((e) => e.currency === currency).forEach((e) => { names.set(e.payerId, e.payerName); e.splits.forEach((s) => names.set(s.friendId, s.friendName)); });
  const amounts = new Map([...names.keys()].map((id) => [id, 0]));
  group.expenses.filter((e) => e.currency === currency).forEach((e) => {
    amounts.set(e.payerId, (amounts.get(e.payerId) || 0) + e.price);
    e.splits.forEach((s) => amounts.set(s.friendId, (amounts.get(s.friendId) || 0) - s.amount));
  });
  return [...names].map(([id, name]) => ({ id, name, amount: amounts.get(id) || 0, removed: !group.friends.some((f) => f.id === id) }));
}

function getConvertedBalances(group: Group, primaryCurrency: string, rates: Record<string, string>): Balance[] {
  const names = new Map<string, string>();
  group.friends.forEach((friend) => names.set(friend.id, friend.name));
  group.expenses.forEach((expense) => {
    names.set(expense.payerId, expense.payerName);
    expense.splits.forEach((line) => names.set(line.friendId, line.friendName));
  });
  const amounts = new Map([...names.keys()].map((id) => [id, 0]));
  group.expenses.forEach((expense) => {
    const issue = expenseIssue(expense);
    if (issue) throw new Error(issue);
    const rate = expense.currency === primaryCurrency ? "1" : rates[expense.currency];
    const convertedTotal = convertedAmount(expense.price, rate, primaryCurrency);
    const convertedSplits = allocate(convertedTotal, expense.splits.map(line => BigInt(line.amount)), quantum(primaryCurrency));
    amounts.set(expense.payerId, (amounts.get(expense.payerId) || 0) + convertedTotal);
    expense.splits.forEach((line, index) => amounts.set(line.friendId, (amounts.get(line.friendId) || 0) - convertedSplits[index]));
  });
  return [...names].map(([id, name]) => ({ id, name, amount: amounts.get(id) || 0, removed: !group.friends.some((friend) => friend.id === id) }));
}

function settle(balances: Balance[]): Settlement[] {
  const debtors = balances.filter((b) => b.amount < 0).map((b) => ({ ...b, left: -b.amount })).sort((a, b) => b.left - a.left);
  const creditors = balances.filter((b) => b.amount > 0).map((b) => ({ ...b, left: b.amount })).sort((a, b) => b.left - a.left);
  const result: Settlement[] = []; let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    result.push({ from: debtors[i].name, to: creditors[j].name, amount });
    debtors[i].left -= amount; creditors[j].left -= amount;
    if (debtors[i].left === 0) i++; if (creditors[j].left === 0) j++;
  }
  return result;
}

export default function SplitApp() {
  const [data, setData] = useState<AppData>(() => initialData());
  const [ready, setReady] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [sync, setSync] = useState<"saving" | "synced" | "delayed" | "offline" | "error">("saving");
  const [saveRetry, setSaveRetry] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [friendName, setFriendName] = useState("");
  const [friendError, setFriendError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSequence = useRef(0);
  const group = data.groups.find((g) => g.id === data.activeGroupId) ?? data.groups[0];
  const draft = drafts[group.id] ?? blankDraft();
  const editingExpense = group.expenses.find((expense) => expense.id === editingExpenseId);
  const formFriends = editingExpense ? [...group.friends, ...[{ id: editingExpense.payerId, name: editingExpense.payerName }, ...editingExpense.splits.map((line) => ({ id: line.friendId, name: line.friendName }))].filter((candidate, index, all) => !group.friends.some((friend) => friend.id === candidate.id) && all.findIndex((friend) => friend.id === candidate.id) === index)] : group.friends;
  const currency = draft.currency === "Other" ? draft.otherCurrency.trim().toUpperCase() : draft.currency;
  const split = calculateSplits(draft, formFriends);
  const currenciesInUse = [...new Set(group.expenses.map((e) => e.currency))];
  const primaryCurrency = group.primaryCurrency ?? "SGD";
  const exchangeRates = group.exchangeRates ?? {};
  const conversionCurrencies = currenciesInUse.filter((code) => code !== primaryCurrency);
  const dataIssue = group.expenses.map(expense => { const issue = expenseIssue(expense); return issue ? `${expense.name}: ${issue}` : null; }).find(Boolean) ?? (group.expenses.reduce((sum,expense) => sum+BigInt(expense.price),0n) > BigInt(MAX_AMOUNT) ? "Group total exceeds the supported limit." : null);
  let conversionIssue: string | null = dataIssue;
  if (!conversionIssue) {
    try {
      if (![0,2].includes(precision(primaryCurrency)) || conversionCurrencies.some(code => !validRate(exchangeRates[code]))) throw new Error("Enter a positive rate for every currency (up to 12 decimal places).");
      const total = group.expenses.reduce((sum,expense) => sum+BigInt(convertedAmount(expense.price, expense.currency === primaryCurrency ? "1" : exchangeRates[expense.currency], primaryCurrency)),0n);
      if (total > BigInt(MAX_AMOUNT)) throw new Error("Converted group total exceeds the supported limit.");
    } catch (error) { conversionIssue = error instanceof Error ? error.message : "Check conversion rates."; }
  }
  const conversionReady = !conversionIssue;
  const primaryCurrencyOptions = [...new Set([...currencies.filter((code) => code !== "Other"), ...currenciesInUse])];

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};

    void setPersistence(auth, browserLocalPersistence)
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        unsubscribe = onAuthStateChanged(auth, (user) => { void (async () => {
          if (cancelled) return;
          setReady(false);
          setFirebaseUser(user);
          if (!user) {
            localStorage.removeItem("split-app-data");
            setData(initialData());
            setSync("saving");
            setReady(true);
            setAuthReady(true);
            return;
          }
          try {
            const snapshot = await getDoc(doc(db,"users",user.uid));
            const remote = snapshot.data()?.state as unknown;
            if (!cancelled) setData(isAppData(remote) ? remote : initialData());
            if (!cancelled) setSync(snapshot.metadata.fromCache ? (navigator.onLine ? "delayed" : "offline") : "synced");
          } catch { if (!cancelled) setSync(navigator.onLine ? "error" : "offline"); }
          if (!cancelled) { setReady(true); setAuthReady(true); }
        })(); });
      });

    return () => { cancelled = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!ready || !firebaseUser) return;
    const sequence = ++saveSequence.current;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (slowSaveTimer.current) clearTimeout(slowSaveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSync("saving");
      const slowTimer = setTimeout(() => {
        if (sequence === saveSequence.current) setSync(navigator.onLine ? "delayed" : "offline");
      }, 8000);
      slowSaveTimer.current = slowTimer;
      void setDoc(doc(db,"users",firebaseUser.uid), { state:data, updatedAt:serverTimestamp() })
        .then(() => { if (sequence === saveSequence.current) setSync("synced"); })
        .catch(() => { if (sequence === saveSequence.current) setSync(navigator.onLine ? "error" : "offline"); })
        .finally(() => clearTimeout(slowTimer));
    }, 550);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (slowSaveTimer.current) clearTimeout(slowSaveTimer.current);
    };
  }, [data, ready, firebaseUser, saveRetry]);

  useEffect(() => {
    const handleOnline = () => setSaveRetry((value) => value + 1);
    const handleOffline = () => setSync("offline");
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  async function signIn() {
    try {
      await setPersistence(auth,browserLocalPersistence);
      await signInWithPopup(auth,new GoogleAuthProvider());
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/popup-closed-by-user") window.alert("Google sign-in could not be completed. Please try again.");
    }
  }

  if (!authReady || (firebaseUser && !ready)) return <main className="auth-page"><div className="auth-card auth-loading"><img src="/split-icon-v2.svg" alt="" width={56} height={56}/><p>Loading Split…</p></div></main>;
  if (!firebaseUser) return <main className="auth-page"><section className="auth-card"><img src="/split-icon-v2.svg" alt="" width={68} height={68}/><span className="eyebrow">Shared expenses, simplified</span><h1>Welcome to Split</h1><p>Keep your groups, expenses and settlements securely synced across your devices.</p><button onClick={() => void signIn()} className="google-sign-in"><LogIn size={18}/>Continue with Google</button><small>Your records stay private to your signed-in account.</small></section></main>;

  const updateGroup = (fn: (g: Group) => Group) => setData((old) => ({ ...old, groups: old.groups.map((g) => g.id === old.activeGroupId ? fn(g) : g) }));
  const updateDraft = (patch: Partial<Draft>) => setDrafts((old) => ({ ...old, [group.id]: { ...draft, ...patch } }));
  function addGroup() {
    const next = newGroup(`Group ${data.groups.length + 1}`);
    setData((old) => ({ ...old, groups: [...old.groups, next], activeGroupId: next.id }));
    setFriendName(""); setFriendError(""); setEditingExpenseId(null); setShowForm(false);
  }
  function removeGroup() {
    if (data.groups.length <= 1 || !window.confirm(`Delete “${group.name}” and all its expenses?`)) return;
    setData((old) => {
      const groups = old.groups.filter((item) => item.id !== old.activeGroupId);
      return { ...old, groups, activeGroupId: groups[0].id };
    });
    setFriendName(""); setFriendError(""); setEditingExpenseId(null); setShowForm(false);
  }
  function addFriend() {
    const name = friendName.trim(); if (!name) return;
    if (group.friends.some((f) => f.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setFriendError("That name is already in this group."); return; }
    updateGroup((g) => ({ ...g, friends: [...g.friends, { id: uid(), name }] })); setFriendName(""); setFriendError("");
  }
  function removeFriend(id: string) {
    updateGroup((g) => ({ ...g, friends: g.friends.filter((f) => f.id !== id) }));
    updateDraft({ selected: draft.selected.filter((x) => x !== id), payerId: draft.payerId === id ? "" : draft.payerId });
  }
  function openAddExpense() {
    setEditingExpenseId(null);
    setShowForm(true);
  }
  function openEditExpense(expense: Expense) {
    setDrafts((old) => ({ ...old, [group.id]: draftFromExpense(expense) }));
    setEditingExpenseId(expense.id);
    setShowForm(true);
  }
  function closeExpenseForm() {
    if (editingExpenseId) setDrafts((old) => ({ ...old, [group.id]: blankDraft() }));
    setEditingExpenseId(null);
    setShowForm(false);
  }
  function saveExpense() {
    const payer = formFriends.find((f) => f.id === draft.payerId);
    if (!payer || !split.valid || !draft.name.trim() || Number(draft.price) <= 0 || !currency) return;
    const splitInputs = draft.method === "equal" ? undefined : Object.fromEntries(draft.selected.map((id) => [id, draft.values[id] || "0"]));
    const expense: Expense = { id: editingExpenseId ?? uid(), name: draft.name.trim(), description: draft.description.trim(), price: parseAmount(draft.price, currency)!, currency, date: draft.date, payerId: payer.id, payerName: payer.name, method: draft.method, splits: split.lines, splitInputs };
    updateGroup((g) => ({ ...g, expenses: editingExpenseId ? g.expenses.map((item) => item.id === editingExpenseId ? expense : item) : [expense, ...g.expenses] }));
    setDrafts((old) => ({ ...old, [group.id]: blankDraft() }));
    setEditingExpenseId(null);
    setShowForm(false);
  }

  function exportPdf() {
    if (dataIssue || (group.settleInPrimary && !conversionReady)) return;
    setExporting(true);
    const totals = currenciesInUse.map((c) => ({ c, total: group.expenses.filter((e) => e.currency === c).reduce((s, e) => s + e.price, 0) }));
    const useConversion = Boolean(group.settleInPrimary && conversionReady);
    const sections = useConversion
      ? `<section><h2>Settle up · ${escapeHtml(primaryCurrency)}</h2><p class="note">Converted using your manual rates: ${conversionCurrencies.map((code) => `1 ${escapeHtml(code)} = ${escapeHtml(exchangeRates[code])} ${escapeHtml(primaryCurrency)}`).join(" · ") || "No conversion needed"}</p>${settle(getConvertedBalances(group, primaryCurrency, exchangeRates)).map((s) => `<div class="payment"><b>${escapeHtml(s.from)}</b> pays <b>${escapeHtml(s.to)}</b><strong>${escapeHtml(money(s.amount, primaryCurrency))}</strong></div>`).join("") || "<p>Everyone is settled up.</p>"}</section>`
      : totals.map(({ c, total }) => { const payments = settle(getBalances(group, c)); return `<section><h2>Settle up · ${escapeHtml(c)}</h2><p class="note">${escapeHtml(money(total, c))} spent</p>${payments.length ? payments.map((s) => `<div class="payment"><b>${escapeHtml(s.from)}</b> pays <b>${escapeHtml(s.to)}</b><strong>${escapeHtml(money(s.amount, c))}</strong></div>`).join("") : "<p>Everyone is settled up.</p>"}</section>`; }).join("");
    const expenses = [...group.expenses].sort((a, b) => a.date.localeCompare(b.date)).map((e) => `<tr><td>${escapeHtml(e.date)}</td><td><b>${escapeHtml(e.name)}</b>${e.description ? `<small>${escapeHtml(e.description)}</small>` : ""}</td><td>${escapeHtml(e.payerName)}</td><td>${e.splits.map(line => `<div>${escapeHtml(line.friendName)} · ${escapeHtml(money(line.amount,e.currency))}</div>`).join("")}</td><td>${escapeHtml(money(e.price, e.currency))}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(group.name)} — Split</title><style>${reportCss}</style></head><body><header><div class="brand">SPLIT / REPORT</div><h1>${escapeHtml(group.name)}</h1><p>Generated ${escapeHtml(new Date().toLocaleString())}</p></header><main>${sections}<section><h2>Total spent</h2><div class="totals">${totals.map((t) => `<div><span>${escapeHtml(t.c)}</span><strong>${escapeHtml(money(t.total, t.c))}</strong></div>`).join("")}</div></section><section class="log"><h2>Expense log</h2><table><thead><tr><th>Date</th><th>Expense</th><th>Paid by</th><th>Split with</th><th>Amount</th></tr></thead><tbody>${expenses}</tbody></table></section></main></body></html>`;
    const win = window.open("", "_blank");
    if (!win) { setExporting(false); return; }
    win.document.write(html); win.document.close();
    setTimeout(() => { win.focus(); win.print(); setExporting(false); }, 350);
  }

  const canSave = formFriends.length >= 1 && Boolean(draft.name.trim()) && Number(draft.price) > 0 && Boolean(currency) && Boolean(draft.payerId) && split.valid;
  const syncLabel = sync === "saving" ? "Saving…" : sync === "synced" ? "Synced" : sync === "delayed" ? "Sync delayed · Tap to retry" : sync === "offline" ? "Offline · Will retry" : "Save failed · Tap to retry";
  const syncClass = sync === "synced" ? "text-[#178250]" : sync === "saving" ? "text-[#1769e0]" : "text-[#b54708]";
  const syncDot = sync === "synced" ? "bg-[#16a05d]" : sync === "saving" ? "animate-pulse bg-[#1769e0]" : "bg-[#f79009]";
  const canRetrySync = sync === "delayed" || sync === "error";
  return <main className="min-h-screen bg-[#f7f8fa] text-[#172033]">
    <header className="sticky top-0 z-30 border-b border-[#e5e8ee] bg-white/95 backdrop-blur"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between px-4 py-3 sm:flex-nowrap sm:px-6">
      <div className="order-1 flex items-center gap-2.5"><img src="/split-icon-v2.svg" alt="" width={36} height={36} className="h-9 w-9 shrink-0"/><span className="text-lg font-bold tracking-[-.03em]">Split</span></div>
      {canRetrySync ? <button type="button" onClick={() => setSaveRetry((value) => value + 1)} className={`order-3 mt-2 flex w-full items-center justify-end gap-1.5 text-xs font-medium sm:order-2 sm:ml-auto sm:mt-0 sm:w-auto ${syncClass}`}><span className={`h-2 w-2 rounded-full ${syncDot}`}/>{syncLabel}</button> : <span className={`order-3 mt-2 flex w-full items-center justify-end gap-1.5 text-xs font-medium sm:order-2 sm:ml-auto sm:mt-0 sm:w-auto ${syncClass}`}><span className={`h-2 w-2 rounded-full ${syncDot}`}/>{syncLabel}</span>}
      <div className="order-2 flex items-center gap-2 sm:order-3 sm:ml-2">{authReady && (firebaseUser ? <button onClick={() => void signOut(auth)} className="secondary-button" title={firebaseUser.email ?? "Signed in"}><LogOut size={16}/>Sign out</button> : <button onClick={() => void signIn()} className="secondary-button"><LogIn size={16}/>Sign in</button>)}<button onClick={exportPdf} disabled={exporting || !group.expenses.length || Boolean(dataIssue) || Boolean(group.settleInPrimary && !conversionReady)} className="secondary-button"><Download size={16}/>{exporting ? "Preparing…" : "Export PDF"}</button></div>
    </div></header>
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-5 sm:px-6 sm:pt-8">
      <div className="group-switcher"><label><span className="eyebrow">Current group</span><select aria-label="Current group" value={group.id} onChange={(event) => { setData((current) => ({ ...current, activeGroupId:event.target.value })); setFriendError(""); setEditingExpenseId(null); setShowForm(false); }}>{data.groups.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button onClick={addGroup} className="add-group-button" aria-label="Create a new group"><Plus size={17}/><span>New group</span></button></div>
      <section className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div className="min-w-0"><label className="eyebrow">Group name</label><input aria-label="Group name" value={group.name} onChange={(e) => updateGroup((g) => ({ ...g, name: e.target.value }))} className="group-name"/><p className="mt-1 text-sm text-[#667085]">{group.friends.length} {group.friends.length === 1 ? "friend" : "friends"} · {group.expenses.length} {group.expenses.length === 1 ? "expense" : "expenses"}</p></div><div className="flex items-center gap-2">{data.groups.length > 1 && <button onClick={removeGroup} className="secondary-button danger-button" aria-label={`Delete ${group.name}`}><Trash2 size={16}/>Delete group</button>}<button onClick={openAddExpense} disabled={group.friends.length < 2} className="primary-button"><Plus size={18}/>Add expense</button></div></section>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,.75fr)] lg:items-start"><div className="space-y-5">
        {currenciesInUse.length ? <section className="surface settle-surface"><div className="section-heading"><div><span className="eyebrow">Suggested payments</span><h2>Settle up</h2></div>{group.settleInPrimary && conversionReady && <span className="conversion-badge">Converted to {primaryCurrency}</span>}</div>
          <Tabs value={group.settleInPrimary ? "converted" : "original"} onValueChange={(value) => updateGroup((current) => ({ ...current, settleInPrimary: value === "converted" }))}>
            <TabsList aria-label="Settlement currency" className="settlement-tabs">
              <TabsTrigger value="original">Original currencies</TabsTrigger>
              <TabsTrigger value="converted">Converted currency</TabsTrigger>
            </TabsList>
            <TabsContent value="original" className="space-y-4 pt-3">{dataIssue ? <p role="alert" className="conversion-warning">{dataIssue}</p> : currenciesInUse.map((code) => { const payments = settle(getBalances(group, code)); return <div key={code}><h3 className="mb-2 text-sm font-semibold text-[#667085]">{code}</h3>{payments.length ? payments.map((payment,index) => <div key={index} className="settlement"><span>{payment.from}</span><ArrowRight size={15}/><span>{payment.to}</span><strong>{money(payment.amount,code)}</strong></div>) : <div className="empty-line"><Check size={16}/>Everyone is settled up</div>}</div>; })}</TabsContent>
            <TabsContent value="converted" className="space-y-5 pt-3">
              <div className="space-y-3">
                <label className="field"><span>Settle in</span><select className="input" value={primaryCurrency} onChange={(event) => updateGroup((current) => ({ ...current, primaryCurrency: event.target.value, exchangeRates: {} }))}>{primaryCurrencyOptions.map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
                {conversionCurrencies.map((code) => <label className="rate-field" key={code}><span>1 {code}</span><span>=</span><input aria-label={`Rate from ${code} to ${primaryCurrency}`} className="input" type="number" inputMode="decimal" min="0" step="any" placeholder="Rate" value={exchangeRates[code] ?? ""} onChange={(event) => updateGroup((current) => ({ ...current, exchangeRates: { ...(current.exchangeRates ?? {}), [code]: event.target.value } }))}/><span>{primaryCurrency}</span></label>)}
                <p className="text-sm text-[#667085]">Enter how much 1 unit of the original currency is worth in {primaryCurrency}. Payments update automatically; original expenses stay unchanged. Rounding is per expense; leftover units go to the largest fractional shares, with ties in participant order.</p>
              </div>
              {conversionReady ? (() => { const payments = settle(getConvertedBalances(group, primaryCurrency, exchangeRates)); return <div className="space-y-2" aria-live="polite"><h3 className="text-sm font-semibold">Payments in {primaryCurrency}</h3>{payments.length ? payments.map((payment,index) => <div key={index} className="settlement"><span>{payment.from}</span><ArrowRight size={15}/><span>{payment.to}</span><strong>{money(payment.amount,primaryCurrency)}</strong></div>) : <div className="empty-line"><Check size={16}/>Everyone is settled up</div>}</div>; })() : <p role="status" className="conversion-warning">{conversionIssue}</p>}
            </TabsContent>
          </Tabs>
        </section> : <section className="empty-state"><div className="empty-icon"><CircleDollarSign size={25}/></div><h2>No expenses yet</h2><p>Add at least two friends, then log your first shared expense.</p>{group.friends.length >= 2 && <button onClick={openAddExpense} className="primary-button mt-5"><Plus size={18}/>Add expense</button>}</section>}
        <section className="surface"><div className="section-heading"><div><span className="eyebrow">History</span><h2>Expenses</h2></div><span className="count-pill">{group.expenses.length}</span></div>{group.expenses.length ? <div className="space-y-1">{group.expenses.map((e) => <article key={e.id} className="expense-row"><div className="date-box"><b>{new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined,{day:"2-digit"})}</b><span>{new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined,{month:"short"})}</span></div><div className="min-w-0 flex-1"><h3 className="truncate font-semibold">{e.name}</h3><p className="truncate text-sm text-[#667085]">Paid by {e.payerName}{e.description ? ` · ${e.description}` : ""}</p>{expenseIssue(e) && <p className="expense-review">{expenseIssue(e)}</p>}</div><div className="expense-meta"><strong>{money(e.price,e.currency)}</strong><span className="text-xs text-[#667085]">{methods.find((m)=>m.key===e.method)?.label}</span><ExpenseSplitTooltip expense={e}/></div><div className="expense-actions"><button aria-label={`Edit ${e.name}`} onClick={() => openEditExpense(e)} className="icon-button"><Pencil size={15}/></button><button aria-label={`Remove ${e.name}`} onClick={() => updateGroup((g) => ({ ...g, expenses: g.expenses.filter((x) => x.id !== e.id) }))} className="icon-button"><Trash2 size={16}/></button></div></article>)}</div> : <p className="py-8 text-center text-sm text-[#98a2b3]">Your expense log will appear here.</p>}</section>
      </div>
      <aside className="surface lg:sticky lg:top-24"><div className="section-heading"><div><span className="eyebrow">This group</span><h2>Friends</h2></div><Users size={19} className="text-[#667085]"/></div><form onSubmit={(e) => { e.preventDefault(); addFriend(); }} className="flex gap-2"><input value={friendName} onChange={(e) => { setFriendName(e.target.value); setFriendError(""); }} placeholder="Add a name" aria-label="Friend name" className="input flex-1"/><button className="square-button" aria-label="Add friend"><UserPlus size={18}/></button></form>{friendError && <p className="mt-2 text-xs font-medium text-[#cf3f3f]">{friendError}</p>}<div className="mt-4 space-y-1">{group.friends.map((f) => <div key={f.id} className="friend-row"><span className="avatar">{f.name.slice(0,1).toLocaleUpperCase()}</span><span className="min-w-0 flex-1 truncate font-medium">{f.name}</span><button onClick={() => removeFriend(f.id)} aria-label={`Remove ${f.name}`} className="icon-button"><X size={15}/></button></div>)}</div>{!group.friends.length && <p className="mt-5 text-sm leading-6 text-[#667085]">Start with everyone who may pay or share an expense.</p>}</aside>
      </div>
    </div>
    {showForm && <div className="modal-wrap" role="dialog" aria-modal="true" aria-label={editingExpenseId ? "Edit expense" : "Add expense"}><button className="modal-backdrop" onClick={closeExpenseForm} aria-label="Close"/><section className="modal-panel"><div className="modal-head"><div><span className="eyebrow">{group.name}</span><h2>{editingExpenseId ? "Edit expense" : "Add expense"}</h2></div><button onClick={closeExpenseForm} className="icon-button"><X size={20}/></button></div><div className="modal-body">
      <div className="grid gap-4 sm:grid-cols-2"><label className="field sm:col-span-2"><span>Expense name</span><input autoFocus className="input" placeholder="e.g. Dinner" value={draft.name} onChange={(e) => updateDraft({name:e.target.value})}/></label><label className="field sm:col-span-2"><span>Description <i>optional</i></span><input className="input" placeholder="A short note" value={draft.description} onChange={(e) => updateDraft({description:e.target.value})}/></label><label className="field"><span>Price</span><input className="input" type="number" inputMode="decimal" min="0" step={quantum(currency) / 100} placeholder="0.00" value={draft.price} onChange={(e) => updateDraft({price:e.target.value})}/></label><label className="field"><span>Currency</span><select className="input" value={draft.currency} onChange={(e) => updateDraft({currency:e.target.value})}>{currencies.map((c)=><option key={c}>{c}</option>)}</select></label>{draft.currency === "Other" && <label className="field sm:col-span-2"><span>Currency code</span><input className="input uppercase" maxLength={6} placeholder="e.g. THB" value={draft.otherCurrency} onChange={(e)=>updateDraft({otherCurrency:e.target.value.replace(/[^a-z]/gi,"")})}/></label>}<label className="field"><span>Date</span><input className="input" type="date" value={draft.date} onChange={(e)=>updateDraft({date:e.target.value})}/></label><label className="field"><span>Paid by</span><select className="input" value={draft.payerId} onChange={(e)=>updateDraft({payerId:e.target.value})}><option value="">Choose friend</option>{formFriends.map((f)=><option key={f.id} value={f.id}>{f.name}{!group.friends.some((friend)=>friend.id===f.id)?" (removed)":""}</option>)}</select></label></div><hr/>
      <div><span className="field-title">How should it be split?</span><div className="method-grid">{methods.map((m)=><button key={m.key} onClick={()=>updateDraft({method:m.key,values:{}})} className={draft.method===m.key ? "active" : ""}>{m.label}</button>)}</div></div>
      <div><div className="mb-2 flex items-center justify-between"><span className="field-title">Participants</span><button onClick={()=>updateDraft({selected: draft.selected.length===formFriends.length ? [] : formFriends.map((f)=>f.id)})} className="text-button">{draft.selected.length===formFriends.length ? "Clear" : "Select all"}</button></div><div className="participant-list">{formFriends.map((f)=>{const selected=draft.selected.includes(f.id);return <div key={f.id} className={`participant ${selected?"selected":""}`}><button className="participant-main" onClick={()=>updateDraft({selected:selected?draft.selected.filter((id)=>id!==f.id):[...draft.selected,f.id]})}><span className="check">{selected&&<Check size={13}/>}</span><span>{f.name}{!group.friends.some((friend)=>friend.id===f.id)&&<small className="removed-label">removed</small>}</span></button>{selected && draft.method!=="equal" && <div className="value-wrap"><input type="number" inputMode="decimal" min="0" step={draft.method==="exact" ? quantum(currency) / 100 : "any"} value={draft.values[f.id]??""} onChange={(e)=>updateDraft({values:{...draft.values,[f.id]:e.target.value}})} aria-label={`${f.name} ${draft.method}`}/><span>{draft.method==="percentage"?"%":draft.method==="shares"?"share":""}</span></div>}</div>})}</div><div className={`split-status ${split.valid?"valid":""}`}><span>{split.status}</span>{split.valid&&<Check size={15}/>}</div></div>
    </div><div className="modal-foot"><button onClick={closeExpenseForm} className="secondary-button">Cancel</button><button onClick={saveExpense} disabled={!canSave} className="primary-button">{editingExpenseId ? "Save changes" : "Add expense"}</button></div></section></div>}
  </main>;
}

function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c] || c)); }
const reportCss = `@page{size:A4;margin:18mm}*{box-sizing:border-box}body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Arial,sans-serif;color:#172033;margin:0;font-size:12px}header{border-bottom:2px solid #1769e0;padding-bottom:18px;margin-bottom:22px}.brand{color:#1769e0;font-weight:800;font-size:10px;letter-spacing:.14em}h1{font-size:28px;margin:8px 0 4px}header p{color:#667085;margin:0}section{break-inside:avoid;margin:0 0 24px}h2{font-size:17px;margin:0 0 12px}h3{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#667085;margin:16px 0 8px}.totals{display:flex;gap:10px;flex-wrap:wrap}.totals div{border:1px solid #e5e8ee;border-radius:10px;padding:10px 14px;min-width:120px}.totals span{display:block;color:#667085;font-size:10px}.totals strong{font-size:17px}.row,.payment{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #edf0f4}.payment strong{margin-left:auto;color:#1769e0}.pos{color:#178250}.neg{color:#cf3f3f}table{border-collapse:collapse;width:100%}th{text-align:left;color:#667085;font-size:9px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #d7dce4;padding:8px 6px}td{padding:9px 6px;border-bottom:1px solid #edf0f4;vertical-align:top}td:last-child,th:last-child{text-align:right}small{display:block;color:#667085;margin-top:2px}.log{break-inside:auto}.log tr{break-inside:avoid}`;

function ExpenseSplitTooltip({ expense }: { expense: Expense }) {
  const tooltipId = `expense-split-${expense.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const count = expense.splits.length;
  return <span className="expense-split-tooltip">
    <button type="button" className="expense-split-trigger" aria-describedby={tooltipId} aria-label={`View split breakdown for ${expense.name}`}><Users size={12}/>{count} {count === 1 ? "person" : "people"}</button>
    <span id={tooltipId} role="tooltip" className="expense-split-panel"><strong>Split breakdown</strong>{expense.splits.map(line => <span className="expense-split-line" key={line.friendId}><span>{line.friendName}</span><b>{money(line.amount,expense.currency)}</b></span>)}</span>
  </span>;
}
