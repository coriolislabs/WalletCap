# Quickstart

No wallet, no chain, no keys, no network. The demo uses a fake payee and a
temporary SQLite file.

```sh
node examples/quickstart/quickstart.mjs
python3 examples/quickstart/quickstart.py
```

Both print the same story: three `$0.05` payments against a `$0.15` rolling
cap; a `$1.00` payment refused by the per-payment cap; a fourth `$0.05`
refused by the rolling cap; a restart that asks for looser limits and is
refused because the stored count and limits stay.

The demo opens with `create: true` because it starts from an empty file. A
production agent opens with the default `create: false`, after the owner has
created the budget once:

```sh
npx walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

The demo file is `examples/quickstart/demo.sqlite` and is gitignored.
