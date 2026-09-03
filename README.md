<div align="center">
  <img src="docs/assets/logo.svg" alt="Dotmole" width="180" />
  <h1>Dotmole</h1>
  <p><em>🐾 Good domains are buried deep. Dotmole digs them up.</em></p>
  <p><a href="https://catwithlover.github.io/dotmole/"><strong>Website</strong></a></p>
  <p><strong>English</strong> · <a href="README.zh-TW.md">繁體中文</a></p>
</div>

**Dotmole** is a skill that digs through names and TLDs for ideas, checks availability, and surfaces the strongest domains.

## Features

- Generates a concise, relevant set of domain candidates from a naming brief.
- Explores brand names, compounds, alternative TLDs, and domain hacks.
- Recommends only domains that Spaceship explicitly reports as available.
- Shows premium pricing, TLD restrictions, and the time of each check.
- Checks availability only; it never registers, purchases, transfers, or modifies domains or DNS.

## Installation

Install with Skills CLI:

```bash
npx skills add catwithlover/dotmole
```

Or install manually for your preferred agent. For OpenCode:

```bash
git clone https://github.com/catwithlover/dotmole
cd dotmole
mkdir -p ~/.config/opencode/skills
cp -r skills/dotmole ~/.config/opencode/skills/
```

Restart OpenCode after installation so it can load the new skill.

## Usage

After installing [`skills/dotmole`](skills/dotmole) in an Agent Skills-compatible tool, describe what you need in natural language:

```text
Find available domains for a monitoring service called QuietPing.
Prioritize .com and TLDs suited to developer tools. Avoid hyphens, numbers, and premium domains.
```

You can also ask Dotmole to generate ideas without making network requests. In that case, every result is clearly marked as unverified.

## Requirements

- Node.js 22 or later
- Spaceship API credentials with read-only `domains:read` permission

## Environment variables

Set these variables before starting your agent to enable live availability checks:

| Variable               | Purpose              |
| ---------------------- | -------------------- |
| `SPACESHIP_API_KEY`    | Spaceship API key    |
| `SPACESHIP_API_SECRET` | Spaceship API secret |

Linux or macOS:

```bash
export SPACESHIP_API_KEY="your-api-key"
export SPACESHIP_API_SECRET="your-api-secret"
```

## License

[MIT](LICENSE)
