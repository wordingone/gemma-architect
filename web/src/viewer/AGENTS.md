# viewer/

Owns viewport rendering, selection picking, and gumball/transform interaction.

Expected contents:
- viewer scene/camera/render loop
- transform controls / gumball logic
- sub-object handles and refit behavior

Constraints:
- Selection and gumball input ordering must remain stable.
- Keep world/local coordinate conversions explicit.

