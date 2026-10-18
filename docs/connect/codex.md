# Connect Eyes to OpenAI Codex

The Codex CLI and the Codex IDE extension/app share `~/.codex/config.toml`. Add Eyes once and both see it.

MCP server URL: `https://api.eyes.pictures/mcp` (streamable HTTP)

Tested with `codex-cli 0.158.0`.

## CLI one-liner

After you have a key (step 1 below):

```sh
codex mcp add eyes --url https://api.eyes.pictures/mcp --bearer-token-env-var EYES_API_KEY
```

## Steps

1. Get a test key. No browser needed:

   ```sh
   curl -s -X POST https://api.eyes.pictures/v1/signup \
     -H 'content-type: application/json' \
     -d '{"name": "my-codex"}'
   ```

   Save the `api_key` value in a file only you can read. Keep the file outside any repo:

   ```sh
   mkdir -p ~/.config/eyes && chmod 700 ~/.config/eyes
   umask 077
   printf 'export EYES_API_KEY=%s\n' 'eyes_test_...' > ~/.config/eyes/env
   ```

2. Add the server:

   ```sh
   codex mcp add eyes --url https://api.eyes.pictures/mcp --bearer-token-env-var EYES_API_KEY
   ```

3. Load the key into your shell and check the entry:

   ```sh
   source ~/.config/eyes/env
   codex mcp list
   ```

## config.toml block

The same thing, written by hand. This is what `codex mcp add` writes:

```toml
[mcp_servers.eyes]
url = "https://api.eyes.pictures/mcp"
bearer_token_env_var = "EYES_API_KEY"
```

The file stores only the name of the environment variable. The key itself never goes in `config.toml`.

## OAuth alternative

OAuth lets you skip the key in your shell. It needs a browser for sign-in:

```sh
codex mcp add eyes --url https://api.eyes.pictures/mcp
codex mcp login eyes
```

`codex mcp login eyes --no-browser` prints the sign-in URL instead of opening a browser. You then paste the callback URL back in.

Not tested in this repo. If login fails, use the bearer setup above. To switch, run `codex mcp remove eyes` first.

## What you should see

- `codex mcp list` shows `eyes`, `https://api.eyes.pictures/mcp`, `Bearer token`, `enabled`.
- In a Codex session, `/mcp` lists `eyes` with its tools. These include `quote_task`, `ask_eyes`, `await_answer`, `get_task` and `get_balance`.
- `quote_task` only quotes a price. It does not post a task. A test run returned:

  ```json
  {"workers_nearby":0,"suggested_bounty_usd":3,"allowed":true,"resolved_location":{"label":"Ferry Building, San Francisco"}}
  ```

- `ask_eyes` posts a real task to a nearby person and charges your balance. With a test key, the balance is test money.

Run a check with no task posted (uses your Codex quota):

```sh
EYES_API_KEY=eyes_test_... codex exec "Use the eyes MCP tool quote_task for location 'Ferry Building, San Francisco', task_type is_open. Reply with the raw tool result."
```

## Troubleshooting

- **`401 unauthorized: Missing or invalid API key`.** Codex did not see `EYES_API_KEY`. Check its length with `echo ${#EYES_API_KEY}` (prints a number only; `0` means unset). Start Codex from the shell where you ran `source ~/.config/eyes/env`.
- **`You've hit your usage limit`.** This is your Codex plan's quota, not Eyes. Check https://chatgpt.com/codex/settings/usage.
- **`MCP HTTP redirect to a different origin is not allowed`.** Codex does not follow redirects to another host. Confirm the URL is exactly `https://api.eyes.pictures/mcp`. Other MCP servers in your config can log this same error at startup. To check Eyes alone, run `CODEX_HOME=$(mktemp -d) codex mcp list` with a copy of the `eyes` block placed in that directory's `config.toml`.
- **`api.eyes.pictures` does not resolve.** Test with curl and pin the address: `curl --resolve api.eyes.pictures:443:104.21.39.209 ...`. That IP came from a test run and may change.
- **The IDE app does not see the key.** GUI apps do not inherit shell variables. Start the app from a terminal where the variable is exported, or use the OAuth setup. Not tested here.
- **Reset.** `codex mcp remove eyes`, then add it again.

To check the key without Codex, send a bare request. `401` means the key is missing or wrong. A valid key on a bare POST returns `400`, because there is no JSON-RPC body:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.eyes.pictures/mcp \
  -H "authorization: Bearer $EYES_API_KEY"
```
