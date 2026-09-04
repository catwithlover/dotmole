# Spaceship Availability API

Last verified: 2026-09-04

Official documentation: <https://docs.spaceship.dev/>

## Allowed operation

This skill uses only the domain availability operation:

- Endpoint: `POST https://spaceship.dev/api/v1/domains/available`
- Permission: `domains:read`
- Authentication headers: `X-API-Key` and `X-API-Secret`
- Request body: `{"domains":["example.dev"]}`
- Batch size: 1 to 20 fully qualified ASCII A-label domains
- Rate limit: 30 availability requests per user per 30 seconds

The endpoint uses POST because it accepts a batch body, but it only checks availability. Do not call registration, renewal, transfer, DNS, contact, billing, or other write endpoints.

## Credentials

Read credentials only from the process environment:

- `SPACESHIP_API_KEY`
- `SPACESHIP_API_SECRET`

Do not open `.env`, search for credentials, accept secrets in command arguments, print request headers, or include secrets in errors. If the variables are absent, ask the user to export them before starting a new agent process.

## Response handling

Treat only an explicit `result: "available"` from a successful response as available. Treat missing items, unfamiliar result values, malformed responses, and failed batches as unknown rather than guessing.

All HTTP-level, transport-level, and whole-response schema failures apply to the provider request as a whole. After one of these failures, stop sending batches and mark every remaining domain as unknown. Per-domain statuses in an otherwise valid response affect only those domains, so later batches may continue.

The official `DomainAvailabilityStatus` values are:

- `available`: normalize to `available`.
- `taken`: normalize to `unavailable` for new registration. Spaceship notes that it may be available for transfer.
- `invalidDomainName`: normalize to `unknown` and report a provider validation error.
- `tldNotSupported`: normalize to `unknown` and report that Spaceship does not support the TLD.
- `unexpectedError`: normalize to `unknown` and report that availability could not be determined.

`premiumPricing` may contain operation, price, and currency entries. Show those values as point-in-time provider information when present, not as a binding quote. The endpoint does not provide ordinary registration or renewal prices, so do not claim that a non-premium domain meets a budget without a separate authorized price source.

Availability is point-in-time information, not a reservation. State the provider and check time in recommendations and advise the user to recheck immediately before registration.

## CLI exit behavior

The checker may emit useful structured JSON on stdout with a nonzero exit code:

- `0`: complete report without errors.
- `2`: usage, input, or configuration error. Input and configuration failures emit JSON; argument syntax failures may emit only stderr.
- `3`: provider, validation, or partial-result errors with JSON on stdout.
- `1`: unexpected failure; JSON is not guaranteed.

Always parse stdout when it contains JSON. A timestamp created for an input, credential, or configuration failure is report-generation time, not evidence that a provider request occurred.

The checker accepts at most 60 unique domains in one invocation and at most 16 KiB through standard input. Exceeding either limit returns `input_limit_exceeded` without sending a provider request; input is never silently truncated.

The first version of the checker rejects both Unicode input and `xn--` internationalized labels rather than applying an implicit runtime-specific IDNA conversion. IDN checking can be added later with an explicit IDNA2008 dependency.
