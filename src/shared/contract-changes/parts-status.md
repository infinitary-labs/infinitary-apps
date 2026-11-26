# Parts status

A task's board row and its detail gain an optional `partsStatus`: on a backlog parent that runs no program and nothing blocks, the most pressing status among its open parts.
A view reads it as that parent's status word, so the parent reads Working while a part works and Waiting on you while a part's card waits.
An older home sends no `partsStatus`, and a newer view keeps the parent's Backlog word.
An older view ignores the field.
