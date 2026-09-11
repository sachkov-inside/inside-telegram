---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask a coherent group of frontier decisions in each round, up to the runtime's question limit. Then wait for the user's answers before the next round.

At the start of a round, say in one sentence what the round will decide and why it matters. Use the runtime's structured question UI when it is available. Each question covers one decision and uses the user's language. Prefer ordinary words; keep code, commands, exact product or API names, and established project terms unchanged. If an unfamiliar specialist term is necessary, explain it in plain words when it first appears.

Offer two or three choices only when they are real alternatives. Put wording shared by every choice in the question, then give the choices short, parallel labels. Use `yes` and `no` only when both consequences are already obvious. Each choice has:

- a short, everyday label that makes sense without internal workflow jargon;
- one short sentence saying what changes, including the main drawback;
- a recommendation, stated first or clearly marked, with a plain-language reason.

When a free-form answer would be more natural, ask for it directly instead of inventing choices. Outside a structured UI, use this compact fallback:

```text
1. <one direct question>
   - <choice> — <what it changes>
   - <choice> — <what it changes>
   Recommendation: <choice>, because <plain reason>.
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
