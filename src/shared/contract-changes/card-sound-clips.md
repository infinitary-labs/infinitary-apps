A card may play sound clips (docs/card-authoring.md, "Sound clips"): M4A, MP3 and WAV files the host verified and kept beside the card's pictures.
A computer that runs work sends each clip a card plays through `inf:work:media` with its kind (`m4a`, `mp3` or `wav`) before the card.
It sends such a card only to a home that lists this change, and refuses it in words otherwise.
`inf:cards:media` may answer a clip's piece with its sound type, and only a view that plays sound asks for a clip.
An older view never asks for one, since it draws no Listen button, and an older home refuses a clip's name as it refuses any name it did not mint.
