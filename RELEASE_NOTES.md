# Motion Database 2.3.10

- Fix table input creation that could throw a `HierarchyRequestError` when opening a table or entering edit mode.
- Create SQL result elements inside their output container so running or restoring queries does not append elements to the document root.
- Create temporary CSV controls and foreign-key autocomplete elements under valid DOM parents.
