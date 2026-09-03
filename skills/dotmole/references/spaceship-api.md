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

The official `DomainAvailabilityStatus` values are:

- `available`: normalize to `available`.
- `taken`: normalize to `unavailable` for new registration. Spaceship notes that it may be available for transfer.
- `invalidDomainName`: normalize to `unknown` and report a provider validation error.
- `tldNotSupported`: normalize to `unknown` and report that Spaceship does not support the TLD.
- `unexpectedError`: normalize to `unknown` and report that availability could not be determined.

`premiumPricing` may contain operation, price, and currency entries. Show those values when present, but do not invent ordinary registration or renewal prices when the API does not return them.

Availability is point-in-time information, not a reservation. State the provider and check time in recommendations and advise the user to recheck immediately before registration.

The first version of the checker rejects both Unicode input and `xn--` internationalized labels rather than applying an implicit runtime-specific IDNA conversion. IDN checking can be added later with an explicit IDNA2008 dependency.
