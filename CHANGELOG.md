# Changelog

Release notes for each version. The release workflow copies the section matching the version in `app.json` into the GitHub Release.

## 1.1.0 — 2026-10-03

### New
- **Sample groups to get you started.** New installs open with three example groups that show how SplitMate is used: *Murree Weekend Trip* (friends' trip, different ways of splitting), *Flat 4B — Shared Home* (three months of rent and bills) and *Dubai Family Holiday* (a trip in AED, split by family size). Remove them in one tap from the home screen, or add them again from **Settings → Getting started**.
- **Your own categories.** Tap **+ New** under Category when adding an expense to create categories like "Gym" or "School fees". Long-press one to remove it.
- **Every world currency.** Groups can now use any of about 160 currencies. Common ones are one tap away; search for the rest by name or code (e.g. "rupee", "LKR").
- **Calendar date picker.** Expense and payment dates are chosen from an in-app calendar, with quick Today and Yesterday buttons.

### Improved
- **Expense list shows everything at a glance.** Each expense shows its category icon, who paid, how it was split, each person's share, the note, and what it means for you ("You lent…", "You owe…"). Payments show who paid whom.
- **Insights reorganised.** A clear headline total, a new *Your money* section (what you paid against your share), an *At a glance* summary, categories with their change from the previous period, and spending by group.
- **Consistent look.** Messages, confirmations and the transaction details screen now match the rest of the app.
- **Typing is never hidden.** The screen scrolls so the field you are typing in stays above the keyboard.

### Fixed
- **Imported amounts were 100 times too small.** A group file with an amount of 1500 was imported as 15.00. Group and backup files now store normal amounts (1500 means 1,500). Files exported by earlier versions still import correctly.

### Good to know
- Group files and backups exported from 1.1.0 use a newer file format. Update SplitMate on every phone that shares a group, because older versions can't open these files.
- Your existing groups, expenses and settings are kept when you update.

## 1.0.0

- First release: offline groups, four ways to split expenses, balances and settle-up suggestions, insights, PDF and Excel reports, sharing groups as files, backups and an optional PIN lock.
