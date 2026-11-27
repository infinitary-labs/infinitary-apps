A model from a custom connection's server list may carry `notChat: true`, when the server says the model takes no chat turn, such as a decision or embedding model.
A side without this change drops the field and shows that model as pickable; its check still refuses it on Save.
