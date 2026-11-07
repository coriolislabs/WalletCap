# Quickstart

No wallet, no chain, no keys, no network. The demo uses a fake payee and a
temporary SQLite file.

```sh
npm install && npm run build --workspace packages/js
node examples/quickstart/quickstart.mjs
python3 examples/quickstart/quickstart.py
```

The JavaScript demo runs the package built in `packages/js/dist`; the Python demo runs
`packages/python/src`.

Both print the same story: three `$0.05` payments against a `$0.15` rolling
cap; a `$1.00` payment refused by the per-payment cap; a fourth `$0.05`
refused by the rolling cap; a restart whose code asks for looser limits, which
gets the stored count and limits, and a warning: a process can tighten its own
limits, never loosen them.

The demo opens with `create: true` because it starts from an empty file. A
production agent opens with the default `create: false`, after the owner has
created the budget once:

```sh
npx walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

The demo file is `examples/quickstart/demo.sqlite` and is gitignored.
