# Machine-assisted Korean translation notice

The PoB-only fallback strings in `manual/machine-fallback.json` were generated
offline with `Helsinki-NLP/opus-mt-tc-big-en-ko` at revision `main`.

- Model: <https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-ko>
- Authors: Language Technology Research Group at the University of Helsinki
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- Use in this project: machine-assisted draft text for PoB-only display strings

The initial Korean-release C++ source-literal draft was generated primarily
with `SimpleJerry/longtu-nllb-zh2ko` at the pinned revision
`earlystop-v1-ckpt48000`. The model is a game-localisation fine-tune of
`facebook/nllb-200-distilled-600M`; its model card declares CC BY-NC 4.0 and
non-commercial use only.

- Direct model: <https://huggingface.co/SimpleJerry/longtu-nllb-zh2ko>
- Pinned revision: `earlystop-v1-ckpt48000`
- License declared by the model card: Creative Commons Attribution-
  NonCommercial 4.0 International (CC BY-NC 4.0)
- Use in this project: initial draft text for PobTools C++ display literals,
  retained only as non-releasable suggestions pending source-level review

Rejected direct-model rows were retried through
`Helsinki-NLP/opus-mt-zh-en` as an intermediate English conversion and the
English-to-Korean model above. Both Helsinki models declare CC BY 4.0. When a
source literal has an exact shared English identity, the official Korean Path
of Exile mapping is used directly instead of a machine model.

- Intermediate model: <https://huggingface.co/Helsinki-NLP/opus-mt-zh-en>

The custom PoE1 catalogues (maps, scarabs, astrolabes, regex entries, atlas
nodes and Timeless Jewel data) do not use machine-generated output in the
shipped files. Current names and descriptions come from pinned official Korean
RePoE exports for patch `3.29.3.2`; historical/custom-only labels use reviewed
manual mappings. The generation report records `machine: 0`.

Official Path of Exile Korean mappings for patch `3.29.3.2`, reviewed manual
PoB UI strings, and reviewed rejection overrides take precedence over every
fallback. Formatting tokens are verified before a generated value is accepted.

The optional source-literal machine tool supports suggestion generation and
retry only. It writes `source-translation-suggestions.json`, refuses the
canonical `source-translations.json` path, and never applies or restores C++
source files. A machine suggestion can enter the canonical map only after an
explicit review changes its status and records reviewed provenance; the release
overlay accepts only `official`, `reviewed`, or `intentional` rows.
