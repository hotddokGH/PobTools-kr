# Machine-assisted Korean UI fallback

The PoB-only fallback strings in `manual/machine-fallback.json` were generated
offline with `Helsinki-NLP/opus-mt-tc-big-en-ko` at revision `main`.

- Model: <https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-ko>
- Authors: Language Technology Research Group at the University of Helsinki
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- Use in this project: machine-assisted draft text for PoB-only display strings

Official Path of Exile Korean mappings for patch `3.29.3.2`, reviewed manual
PoB UI strings, and reviewed rejection overrides take precedence over this
fallback. Formatting tokens are verified before a generated value is accepted.
