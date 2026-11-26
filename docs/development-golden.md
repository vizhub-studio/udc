# Six-dataset development cube acceptance

Run `npx vitest run test/development-golden.test.ts` in a real checkout. The suite is offline and deterministic; it does not download data or depend on a VizHub service.

## Source inventory

The initial common country/year sample is India, China and the United States in 1960 and 2010, matching the repository's already committed 2014 historical fixtures. It is intentionally smaller than a representative global panel; the rollups are totals of observed fixture countries, never full continent or world estimates.

| Dataset | Original codes | Source units | Status |
| --- | --- | --- | --- |
| UN population, `total_population.csv` | M49 | thousands of persons | Existing historical fixture |
| World Bank GDP, `GDP_current_USD.csv` | ISO alpha-3 | current US dollars | Existing historical fixture |
| Global Carbon Budget fossil and industry CO2, `development-co2.csv` | ISO alpha-3 | million tonnes | Rounded real observations |
| Renewable infrastructure | country names | MW, GWh | Fictional deterministic fixture |
| Climate investment | invented country codes | thousands of USD | Fictional deterministic fixture |
| US state climate and energy statistics | postal abbreviations | persons, USD, tonnes, MW | Fictional allocation across all 50 states |

The first two files are reused unchanged from the historical example. For CO2, the six numbers are transcribed from the CO2Stats country tables based on Our World in Data and Global Carbon Budget 2025: [India](https://co2stats.com/co2/countries/india), [China](https://co2stats.com/co2/countries/china), [United States](https://co2stats.com/co2/countries/united-states). CO2Stats documents retrieval of the OWID data on October 16, 2026 and CC BY 4.0 terms; see [OWID CO2 and greenhouse gas emissions](https://ourworldindata.org/co2-and-greenhouse-gas-emissions) and [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The displayed values are rounded in the source and are not presented as full-precision primary-source observations. The copied rows and their order are fixed. Original population/GDP releases differ from the carbon source vintage.

Synthetic infrastructure and investment values are arithmetic sequences, not historical estimates. The state fixture distributes each national total equally in integer shares with the final state receiving the remainder; these are intentionally fictional, including GDP and population. An additional missing-state variant tests reconciliation gaps. The country fixture's synthetic investment variant distinguishes absent rows, explicit nulls and zero. No fictional value should be used as real-world evidence.

## Analytical boundary

The five country-grain datasets form one query catalog; the state fixture is a separate finer-grain catalog to avoid ambiguous source selection and mixed country/state observations. The hierarchy is a fixture tree, not an official geographic standard. Use the original fine-grained state data for drill-down; totals cannot be inverted. State-to-country, continent and world rollups preserve the original state-row contributors and are not global coverage claims.

The suite checks raw-record join and ratio oracles, transitive source-row provenance, extrema overrides, ranking and limits, filtered/projected provider parity, stale revisions and sparse data. It does not test a live SQL backend, cross-grain integration, or the VizHub authorization layer.

## Release readiness

Candidate next minor version is 3.1.0 if the registry confirms 3.0.0 is the current release. Before changing manifest and lockfile versions, check `npm view @vizhub/udc version` and the available versions. Consolidate the unreleased changes into the selected version after verifying the registry. The release must include the async provider boundary as appropriate, N-way integration, composable calculated measures, explicit aggregation overrides and extrema. Run the full check, package smoke test and example on the exact release commit; publish only through the separate trusted publisher workflow and verify the installed tarball. This test PR does not publish or change the package version.
