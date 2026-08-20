# Contributing

## Two constraints that are not negotiable

**No dependencies.** Not one. Everything ships as the files in this repo, and a
reader can audit the whole thing without trusting a lockfile. A pull request
adding a package will be declined however good the package is.

**No build step.** `chrome://extensions` → Load unpacked → this folder has to
work on a fresh clone. What you read is what runs.

Both exist because this tool holds people's API keys. Auditability is the
feature.

There is also no telemetry, and there will not be. If you want to know how
something behaves in the wild, add something the user can choose to send you.

## Running it

```sh
git clone https://github.com/olivervanderlugt/video-summary-extension.git
cd video-summary-extension
node --test          # 143 tests, no install needed
```

To load it: `chrome://extensions` → Developer mode → Load unpacked → this
folder. Content scripts only inject into pages loaded after that, so reload any
YouTube tab you already had open.

## The development harness

`src/content/*` needs a browser, so there is a fake watch page that mounts the
real content scripts against a real caption fixture:

```sh
python3 dev/serve.py
```

- `http://localhost:8777/watch?v=aircAruvnKk` — the panel, with a stand-in
  worker that runs the real transcript, prompt and markdown modules and fakes
  only the provider request.
- `http://localhost:8777/options` — the real settings page with a `chrome` stub.

`window.__harnessPace = 30` slows the fake stream so you can catch it
mid-flight. `?tour=1` replays the first-run walkthrough.

`dev/` is not part of the extension — the manifest does not reference it.

## Tests

`node --test`. Pure logic lives in `src/lib/` and is well covered; the service
worker is driven through a `chrome` stub in `test/worker.test.mjs`.

A test that cannot fail is worse than no test. If you add one, break the code on
purpose first and check it goes red.

## Read the log first

`docs/log/` is the project's memory:

- `FACTS.md` — things established by measurement, not reasoning. Each cost real
  time to find. Do not re-derive them; if you contradict one, re-measure and
  update it with the date and the command.
- `DECISIONS.md` — why things are the way they are, including approaches that
  were tried and rejected. If you are about to "fix" something, check here
  first — it may be deliberate.
- `TODO.md` — open work, ranked by what it costs a user.
- `REPORTS.md` — every bug report and what it turned out to be. The pattern
  across entries is worth more than any single one.

Add to them as you go. A fix without its reasoning becomes someone else's
mystery.

## What is hard about this codebase

YouTube's caption endpoint answers 200 with an empty body unless the request
carries a proof-of-origin token. The extension borrows one from the player,
which is why `inject.js` watches the player's own requests. There are also
fallback strategies that scrape YouTube's transcript panel. If you are changing
any of that, read the comments first — every strategy exists because something
measurable failed.

Defensive code around YouTube's DOM is deliberate. Multi-selector fallbacks,
MutationObservers and retry budgets earn their keep: YouTube ships several
layouts and changes them without warning.
