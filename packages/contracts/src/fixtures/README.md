# CASE-001 fixture boundary

`case-001.ts` is the executable, de-identified regression form of the second-part
`NUANJIAN-CASE-001` content case. It is shared by contracts and API tests so the
approved facts and paragraph `sourceRefs` cannot silently drift apart.

The fixture may contain:

- approved semantic facts;
- neutral recipient language;
- synthetic UUIDs used only for source tracing;
- the one-version `LetterDraft` shape supported by the current product;
- explicit safety assertions.

The fixture must not contain:

- the controlled photo or audio bytes;
- raw ASR or uncertain product/meeting names;
- original filenames or absolute filesystem paths;
- user, object-storage, share, media, or provider credentials;
- claims that a real OpenAI call, human test, or production flow passed.

The source material defines three editorial versions. The current engineering
contract supports one draft at a time, so this fixture freezes one safe draft for
regression without claiming that three-version selection has been implemented.
