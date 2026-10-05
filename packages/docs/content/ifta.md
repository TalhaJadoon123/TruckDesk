---
title: IFTA
group: Operations
order: 5
description: What the calculator actually computes, and what it cannot know.
---

## The math

IFTA is an apportioned tax. A carrier pays each member jurisdiction a share of
its total fuel tax, where the share is the vehicle's taxable miles there over
total taxable miles everywhere, less the fuel tax already paid at the pump.

1. Total taxable miles per jurisdiction.
2. Total taxable miles across all jurisdictions.
3. Each jurisdiction's apportioned share of tax paid.
4. Less fuel tax credits.

`packages/core/src/ifta.ts` implements all four steps, plus the fixed fees,
border crossings and the owner-operator deduction.

## Tax periods

Two per year: 1 January - 30 June and 1 July - 31 December. The free calculator
defaults to the current half.

## Where the rates come from

`JURISDICTIONS` carries published IFTA tax rate (cents per gallon), the IRP
standard MPG, and the fuel tax credit for all 45 member states plus DC and a
non-member entry for Mexico. Rates are **overridable per jurisdiction**, because
they change twice a year and your accountant will have the current ones:

```json
{ "overrides": { "OH": { "taxRateCentsPerGallon": 24.5 } } }
```

A carrier can also pass `actualMpg`, which replaces the IRP standard. Measured
MPG beats the standard for every jurisdiction at once.

## The honest limitation

When you enter only miles, gallons are derived from your MPG and the IRP
standard, and the app says so in `notes`. That is a good estimate and a poor
filing.

For a filing-grade number you need gallons per jurisdiction, which is what fuel
card entries give you - fuel is bought where the truck is. `POST /ifta/calculate`
reads `fuelEntries.jurisdictionCode` and uses those gallons. Tag the jurisdiction
on the fuel entry screen and the credits become exact.

Second limitation: a load logged as an origin and a destination is split 50/50.
For a load from Ohio to Pennsylvania where most of the miles are in one state,
that is wrong. Record per-state stop mileage for real apportionment.

## Credits and negative balances

Credits are claimed on gallons **purchased in** the jurisdiction, not on
apportioned gallons. If credits exceed the apportioned tax, the net is negative:
an overpayment carried forward, which most carriers have and few calculators
show you.

## Verify before filing

The estimate is a planning tool. Confirm rates and fuel receipts with your
accountant. The notes in the response tell you exactly which inputs were derived
rather than reported.