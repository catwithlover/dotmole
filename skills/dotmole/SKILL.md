---
name: dotmole
description: Dotmole finds, verifies, and ranks available domain names using the read-only Spaceship API. Use whenever a user asks for domain ideas, domain availability, brandable domains, TLD recommendations, naming alternatives, or wordplay/domain hacks, even when they do not explicitly mention Spaceship.
license: MIT
compatibility: Requires Node.js 24+, network access, and SPACESHIP_API_KEY plus SPACESHIP_API_SECRET in the process environment for live checks.
metadata:
  provider: spaceship
  access: read-only
---

# Dotmole

Dig through a naming brief like a domain-hunting mole and surface a short, reasoned list of domains that Spaceship explicitly reports as available.

## Safety boundary

Use only the bundled `scripts/check_domains.mjs` checker. It calls the Spaceship domain availability endpoint and requires only `domains:read` permission.

Never register, reserve, renew, transfer, purchase, or modify a domain. Never call DNS, contact, billing, or other write APIs. Do not open `.env`, search for credentials, ask the user to paste secrets, or pass secrets as command arguments. The checker reads credentials only from its process environment and redacts them from errors. Reporting `premiumPricing` returned by the availability endpoint is allowed, but never present it as a binding price quote.

If the user forbids network access, generate ideas only, label every idea as unverified, and do not run the checker. Explicitly state that no provider check or check timestamp exists.

## Workflow

### 1. Understand the brief

Extract what the user has already supplied:

- Seed words or required text
- Project, audience, and industry
- Preferred or excluded TLDs
- Tone, language, and geographic relevance
- Maximum length
- Whether hyphens, numbers, abbreviations, or invented spellings are acceptable
- Budget and tolerance for premium names, while recognizing that this checker cannot verify ordinary registration or renewal prices

Do not interrogate a user whose intent is already clear. Ask one concise follow-up only when a missing constraint would materially change the search. Otherwise use sensible defaults: no hyphens or numbers, non-premium names preferred, concise English spelling, and a mix of exact and creative options.

### 2. Build a focused candidate set

Read `references/tld-guidance.md` when selecting TLDs, creating domain hacks, or handling a sponsored, geographic, or unfamiliar TLD.

Generate 30 to 40 distinct candidates for the first pass:

1. Exact seed plus 5 to 8 contextually strong TLDs
2. Clear compounds using the product role, audience, or benefit
3. Short action prefixes or suffixes such as `get`, `use`, `labs`, `tools`, or `hq` only where natural
4. Phrase-like names and domain hacks where the extension completes the thought
5. A few spelling alternatives only if they remain easy to hear and type

Keep the strongest candidates, not every mechanical combination. Do not recommend typo-like names merely because they may be available. Treat the second-level label and TLD as one phrase; `digwith.me` can be stronger than an unrelated word followed by a fashionable TLD.

### 3. Check availability

Resolve `scripts/check_domains.mjs` relative to this skill's base directory, not relative to the user's project. Never pass raw user text into a shell command. Generate candidates first, retain only domain-shaped values, and use a single-quoted heredoc so the shell cannot expand candidate text:

```bash
node "/path/to/dotmole/scripts/check_domains.mjs" --pretty --stdin <<'DOMAINS'
dotmole.dev
dotmole.app
dotmole.sh
dotmole.build
DOMAINS
```

The script validates ASCII-only domain names, de-duplicates candidates, accepts at most 60 unique candidates and 16 KiB of standard input, and batches requests in groups of 20. This first version rejects Unicode and `xn--` labels rather than risk checking a different domain through legacy IDNA conversion. Do not add an env-file option or source a credential file yourself.

Always inspect stdout even when the checker exits nonzero. The exit-code contract is:

- `0`: the checker produced a complete report without errors.
- `2`: usage, input, or configuration error. Input and configuration errors include structured JSON on stdout; command-line syntax errors may write only to stderr.
- `3`: the checker produced structured JSON with provider, validation, or partial-result errors. Preserve any explicit `available` results in that report.
- `1`: unexpected checker failure; structured JSON is not guaranteed.

Interpret every structured report conservatively:

- Recommend only results whose `availability` is exactly `available`.
- The checker normalizes Spaceship's `taken` provider result to `unavailable`.
- Treat `unknown`, omitted results, and failed batches as unverified.
- Treat `complete: false` as a partial result and explain what was not checked.
- Show `premiumPricing` when present as provider-returned point-in-time information, not as a binding quote. Do not invent ordinary registration or renewal prices. If the user supplied a budget, state that ordinary pricing could not be verified.
- If credentials are missing, tell the user to export both variables before launching a new agent process. Do not work around this by reading `.env`.

Only when the first API pass has `complete: true`, if fewer than 8 useful names are available, generate one additional pass informed by unavailable names. Do not launch a second pass after authentication, permission, rate-limit, network, or malformed-response errors. Keep the complete search to at most 60 candidates.

### 4. Rank confirmed results

Adapt ranking to the user's stated priorities. When no custom weighting is given, use this heuristic:

| Factor | Weight |
| --- | ---: |
| Meaning and fit with the brief | 30 |
| Memorability and pronunciation | 20 |
| TLD relevance and audience trust | 20 |
| Brevity and spelling clarity | 20 |
| Known commercial friction, including returned premium pricing | 10 |

Use the score to order choices, not to imply scientific precision. Penalize unnecessary hyphens, digits, awkward plurals, ambiguous spelling, weak TLD fit, premium pricing the user did not accept, and obvious trademark risk. Never claim legal clearance.

### 5. Present the answer

Respond in the user's language. After a live check, lead with up to 10 best confirmed options in a compact table. If fewer than 5 useful domains are confirmed available, return only those domains; never pad the list with unavailable or unverified names. In idea-only mode, present up to 10 ideas under an explicit unverified heading instead.

| Rank | Domain | Why it fits | Availability | Premium price |
| ---: | --- | --- | --- | --- |

Then include a short creative-alternatives section only when it adds value. Mention significant TLD caveats, such as HTTPS requirements or sponsored/geographic status, without overwhelming the recommendation.

When at least one provider request occurred, end with the provider and `checkedAt` timestamp. State that availability is point-in-time and does not reserve the domain, so the user should recheck immediately before registration. If no request occurred because network access was forbidden or credentials, input, or configuration were invalid, state that no live check was performed and do not present a report timestamp as a provider check time.

## API details

Read `references/spaceship-api.md` when debugging authentication, permissions, rate limits, response fields, or safety behavior.
