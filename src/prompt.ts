/**
 * ABAP MCP Server — abap_develop Prompt Definition
 * 6-step ABAP development workflow prompt.
 */

export function getAbapDevelopPrompt(objectName: string, task: string) {
  return {
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
`You are an experienced SAP ABAP developer. Your task: "${task}" on object "${objectName}".

## MANDATORY WORKFLOW (follow the order!)

### Step 1: Gather the complete context
1. Run \`search_abap_objects(query="${objectName}")\` to determine the ADT URL.
2. Run \`analyze_abap_context(objectUrl=<url>, depth="deep")\`.
3. Read the context report COMPLETELY before proceeding to step 2.
   ⚠️ NEVER write code without having read ALL includes and referenced objects first!

### Step 2: Research references & alternatives
- For each function module found in the context: check whether modern alternatives exist.
  Examples of outdated patterns → modern alternatives:
    • REUSE_ALV_GRID_DISPLAY → CL_SALV_TABLE / CL_GUI_ALV_GRID
    • POPUP_TO_CONFIRM → IF_FPM_POPUP (for FPM) or custom class
    • READ TABLE ... SY-SUBRC → inline declaration: READ TABLE ... INTO DATA(ls_row)
    • CALL FUNCTION (without exceptions) → TRY/CATCH with CX_* classes
    • WRITE / FORMAT → CL_SALV_TABLE or Web Dynpro / Fiori
- Use \`search_abap_objects\` and \`where_used\` to find alternatives in the system.
- Use \`search_sap_web(query=<topic>)\` to find SAP Notes, blog posts and community solutions for the specific topic.
- When uncertain: search the SAP documentation (web search) for best practices.

### Step 3: Apply modern ABAP principles (Clean ABAP)
**Before coding:** Call \`find_tools(category="QUALITY")\` if not yet done, then run
\`review_clean_abap(source=<existing_code>)\` on the current source to identify existing
anti-patterns and coding conventions before writing new code.

Follow these principles when coding:
- **Inline declarations**: DATA(lv_var), FIELD-SYMBOL(<fs>), NEW #(), VALUE #()
- **String templates**: |Text { lv_var } more text| instead of CONCATENATE
- **Functional methods**: COND #(), SWITCH #(), REDUCE #(), FILTER #()
- **ABAP SQL**: SELECT ... INTO TABLE @DATA(lt_result) (host variables with @)
- **Exceptions**: CX_* classes and TRY/CATCH instead of SY-SUBRC checks
- **OOP**: Classes/interfaces instead of function modules for new logic
- **Naming**: Clean ABAP conventions (no Hungarian notation for new objects,
  but respect existing conventions in the program)
- **Avoid**: MOVE, COMPUTE, obsolete statements (CHECK in methods → RETURN)
- **Testability**: Inject dependencies via interfaces

### Step 3b: ABAP Syntax Rules — MEMORIZE before writing code

**SELECT / ABAP SQL:**
- ✅ Modern (preferred): \`SELECT f1 f2 FROM ztab WHERE k = @lv_k INTO TABLE @DATA(lt) ORDER BY f1 DESCENDING.\`
  ORDER BY, UP TO n ROWS, GROUP BY → only valid in this single-statement form.
- Old loop style: \`SELECT f1 FROM ztab WHERE k = @lv_k INTO lv_v. ... ENDSELECT.\`
  ⛔ ORDER BY is NOT allowed in SELECT...ENDSELECT loops — use SORT after the loop.
  ⛔ Every SELECT...ENDSELECT loop MUST be closed with ENDSELECT before ENDMETHOD/ENDFORM.
  ⛔ NEVER mix styles (no INTO TABLE inside a SELECT...ENDSELECT).

**SORT:**
- ✅ \`SORT lt_table BY field1 ASCENDING field2 DESCENDING.\`
- ASCENDING/DESCENDING are **keywords**, not parameters.
  ⛔ NEVER write \`SORT lt BY f DESCENDING = 'X'.\` — syntax error!

**WRITE ... CURRENCY:**
- ✅ \`WRITE lv_amount CURRENCY lv_waers TO lv_output.\` (lv_output must be CHAR/STRING)
- CURRENCY is a formatting **keyword** here, not a field name.
  ⛔ NEVER use CURRENCY as a variable name in a WRITE statement.

**Comments:**
- Full-line comments use \`*\` in **column 1** (the very first character of the line).
  ⛔ NEVER indent \`*\` — any whitespace before \`*\` is a syntax error!
  ✅ \`* This is a comment\` (column 1)
  ⛔ \`  * This is NOT a valid comment\` (indented — syntax error)
- For indented/inline comments use \`"\`: \`  " This is an indented comment\`

**Type compatibility:**
- Integer literals are type I by default.
  ⛔ NEVER pass a raw integer literal to CURRENCY/AMOUNT typed formal parameters.
- For string conversion use: \`lv_str = |{ lv_amount }|\` or \`WRITE lv_amount TO lv_str.\`

### Step 4: Determine code placement
- Check the context report: which include/class should the new code go into?
- For reports with includes: NEVER put code into the main program if a suitable include exists!
- For classes: choose the correct method / correct include
- For function groups: identify the correct function module

### Step 4b: Look up DDIC structures (MANDATORY for DB tables)
⚠️ **BEFORE writing code** that uses database fields:
1. Identify all tables/structures you want to reference in the code (e.g. VBAK, VBAP, KNA1, EKKO …).
2. For **each** of these tables call \`get_object_info(objectUrl=<adt-url-of-table>)\` — determine the ADT URL via \`search_abap_objects(query=<tablename>, objectType="TABL")\`.
3. Read the returned fields **completely** and remember the **exact** field names.
4. Use **only** field names in the code that you saw in step 3. NEVER invent or guess field names!

### Step 5: Implementation
⚠️ **MANDATORY before the first write_abap_source call:**
0. Ensure validation tools are available: if \`search_abap_syntax\` or \`validate_ddic_references\`
   are not in your tool list, call \`find_tools(category="DOCUMENTATION")\` and
   \`find_tools(category="QUALITY")\` now.
1. For each ABAP statement you want to use (SELECT, LOOP AT, SORT, WRITE, …): call
   \`search_abap_syntax(query=<statement>)\`. Pay attention to the rules in Step 3b.
2. Write the planned code based on verified field names (Step 4b) and syntax (Step 5.1).
3. Call \`validate_ddic_references(source=<planned_code>)\` — final verification.
4. If errors: fix field names. NEVER call \`write_abap_source\` if errors are reported!
5. Only when \`validate_ddic_references\` reports ✅ → call \`write_abap_source\`.

- For syntax/activation errors: analyze, fix, and retry. Only stop if the SAME error persists after 3 attempts. If DIFFERENT errors appear, keep iterating — progress is being made
- If errors persist after multiple attempts: use \`search_sap_web(query=<error_message>)\` to search for the error — often SAP Notes or community posts have the fix.
- After implementation run \`run_syntax_check\` and optionally \`run_unit_tests\`

### Step 6: Quality check
- Run \`run_atc_check\` to ensure code quality
- Fix findings (priority 1 and 2)`,
      },
    }],
  };
}
