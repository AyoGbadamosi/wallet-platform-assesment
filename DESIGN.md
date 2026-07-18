# Design Notes

Fill this in as part of your submission. We'd rather read a clear, honest
account of a partial fix than a vague description of a complete one. Bullet
points are fine; prose is fine. Aim for signal over length.

## 1. What issues did you find?

List everything you identified, whether or not you fixed it. Include how you
found each one (code reading, a failing test, reproducing it under load,
etc.).

-
-
-

## 2. What did you prioritize, and why?

Of everything above, what did you actually spend your time on? What's your
reasoning - severity, blast radius, how common the trigger condition is,
how cheap the fix was, something else?

## 3. How did you handle concurrency?

Where in the system can two requests race each other? What did you change,
and what guarantee does your fix actually provide (e.g. "no negative
balances under any interleaving" vs. "much less likely under realistic
load")? How did you verify it - a test, a manual load script, reasoning
about the code?

## 4. How did you ensure data consistency?

Specifically: across MongoDB writes, the cache, and the message queue. Where
does the system currently allow the ledger, the cached balance, or a
downstream consumer to disagree with the source of truth, and what (if
anything) did you do about each?

## 5. Trade-offs

What did your fixes cost - complexity, latency, throughput, code
readability, backward compatibility? Where did you choose a simpler, more
conservative fix over a more complete one, and why?

## 6. Remaining technical debt

What's still broken or fragile after your changes? Be specific - this is
more useful to us than a clean-sounding summary.

## 7. What would you improve with another day?

If we gave you one more full day on this, where would you spend it and why?

## 8. Assumptions

Anything you assumed about requirements, scale, traffic patterns, or
acceptable behavior that isn't spelled out in the README - state it here so
we can evaluate your reasoning rather than guessing at it.
