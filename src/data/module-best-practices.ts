/**
 * Module-specific SAP ABAP best practices — static data for 15 SAP modules.
 */

export const MODULE_BEST_PRACTICES: Record<string, string> = {
  FI: `# SAP FI (Financial Accounting) — Best Practices

## Important Tables & Structures
- BKPF/BSEG — Document header/line items
- BSID/BSAD — Customer open items (open/cleared)
- BSIK/BSAK — Vendor open items (open/cleared)
- SKA1/SKB1 — G/L accounts (chart/company code)
- T001 — Company codes

## Recommended BAPIs & Classes
- BAPI_ACC_DOCUMENT_POST — Post accounting documents (instead of FB01 directly)
- BAPI_ACC_DOCUMENT_REV_POST — Reverse document
- CL_ACC_DOCUMENT — OO API for documents (S/4HANA)
- BAPI_COMPANYCODE_GETLIST — Read company codes

## Coding Guidelines
- NEVER write directly to BKPF/BSEG — always use BAPIs or ACC classes
- Posting logic via BAPI_ACC_DOCUMENT_POST, not BDC on FB01
- Leave tax calculation to the system (CALCULATE_TAX_FROM_NET_AMOUNT)
- Currency conversion: CONVERT_TO_LOCAL_CURRENCY

## Common Errors
- Direct BSEG selects without index → performance problems (BSEG is a cluster table!)
- In S/4HANA: BSEG is a view on ACDOCA → use SELECT on ACDOCA
- Missing BAPI_TRANSACTION_COMMIT after BAPI calls
- Currency fields without reference to currency key

## S/4HANA Migration
- BSEG → ACDOCA (Universal Journal)
- New CDS Views: I_JournalEntry, I_OperationalAcctgDocItem
- FAGL_SPLITTER replaces classic splitting`,

  CO: `# SAP CO (Controlling) — Best Practices

## Important Tables & Structures
- CSKS/CSKT — Cost centers (master/texts)
- CSKA/CSKB — Cost elements
- COBK/COEP — CO document header/line items
- COSS/COSP — Statistical/plan totals
- AUFK — Internal orders

## Recommended BAPIs & Classes
- BAPI_COSTCENTER_GETLIST — Read cost centers
- BAPI_INTERNALORDER_GETLIST — Read orders
- K_ORDER_READ — Read order data
- BAPI_ACC_ACTIVITY_ALLOC_POST — Activity allocation

## Coding Guidelines
- CO postings always via BAPIs, never directly on COEP
- Read cost center hierarchies via SET function modules
- Plan values via BAPI_COSTCENTER_PLAN_POST
- CO-PA: COPA_FUNCTION_MODULE calls for profitability objects

## Common Errors
- Missing authorization on CO objects (controlling area)
- Period-end accruals not considered in reports
- CO-PA characteristics incorrectly assigned

## S/4HANA Migration
- CO documents integrated in ACDOCA
- CDS Views: I_CostCenter, I_InternalOrder
- Embedded Analytics instead of Report Painter/Writer`,

  MM: `# SAP MM (Materials Management) — Best Practices

## Important Tables & Structures
- MARA/MAKT/MARC/MARD — Material master
- EKKO/EKPO — Purchase order header/line items
- EBAN — Purchase requisitions
- MKPF/MSEG — Material documents
- MCHB — Batch stock

## Recommended BAPIs & Classes
- BAPI_PO_CREATE1 — Create purchase order
- BAPI_PR_CREATE — Create purchase requisition
- BAPI_MATERIAL_GET_DETAIL — Read material master
- BAPI_GOODSMVT_CREATE — Post goods movement
- CL_EXITHANDLER — BAdI implementations for MM enhancements

## Coding Guidelines
- Read material master: BAPI_MATERIAL_GET_DETAIL or SELECT on MARA with buffering
- Purchase orders: BAPI_PO_CREATE1 (never ME_CREATE_PO directly)
- Goods movements: BAPI_GOODSMVT_CREATE with GM_CODE
- Reservations: BAPI_RESERVATION_CREATE1

## Common Errors
- SELECT * on MSEG without restriction → huge data volumes
- Missing COMMIT WORK after BAPI calls
- Unit of measure conversion forgotten (UNIT_CONVERSION_SIMPLE)

## S/4HANA Migration
- MARD simplified (no LQUA directly anymore)
- MATDOC replaces MKPF/MSEG for new documents
- CDS Views: I_PurchaseOrderAPI01, I_Material`,

  SD: `# SAP SD (Sales & Distribution) — Best Practices

## Important Tables & Structures
- VBAK/VBAP — Sales order header/line items
- LIKP/LIPS — Delivery header/line items
- VBRK/VBRP — Billing document header/line items
- KNA1/KNVV — Customer master
- KONV — Conditions

## Recommended BAPIs & Classes
- BAPI_SALESORDER_CREATEFROMDAT2 — Create sales order
- BAPI_DELIVERY_GETLIST — Read deliveries
- BAPI_BILLINGDOC_CREATEMULTIPLE — Create billing document
- SD_SALESDOCUMENT_CREATE — newer API

## Coding Guidelines
- Create orders via BAPIs, not BDC on VA01
- Pricing: use pricing BAdIs, do not change KONV directly
- Availability: ATP function modules (AVAILABILITY_CHECK)
- Partner determination: respect standard partner schema

## Common Errors
- VBAP SELECT without order type restriction → performance
- Bypassing condition technique instead of configuring correctly
- Missing authorization checks on sales organization

## S/4HANA Migration
- CDS Views: I_SalesOrder, I_SalesOrderItem, I_BillingDocument
- Credit management via SAP Credit Management (FIN-FSCM-CR)
- Output management via BRF+`,

  PP: `# SAP PP (Production Planning) — Best Practices

## Important Tables & Structures
- AFKO/AFPO — Production order header/line items
- AFVC/AFVV — Operations/operation values
- STKO/STPO — Bills of material
- PLKO/PLPO — Routings
- RESB — Reservations

## Recommended BAPIs & Classes
- BAPI_PRODORD_CREATE — Create production order
- BAPI_PRODORD_RELEASE — Release order
- BAPI_GOODSMVT_CREATE — Confirmation/goods movement
- CS_BOM_EXPL_MAT_V2 — BOM explosion

## Coding Guidelines
- Production orders: use BAPIs, not CO01 BDC
- BOMs: CS_BOM_EXPL_MAT_V2 for explosion
- Capacity planning: use standard function modules
- Confirmations: BAPI_PRODORDCONF_CREATE_TT

## Common Errors
- BOM explosion without key date
- Missing status check before order operations
- Performance with mass BOM explosions

## S/4HANA Migration
- CDS Views: I_ProductionOrder, I_ManufacturingOrder
- PP/DS partially replaces classic planning`,

  PM: `# SAP PM (Plant Maintenance) — Best Practices

## Important Tables & Structures
- EQUI/EQKT — Equipment
- IFLO/IFLOT — Functional locations
- AUFK — PM orders
- AFIH — Maintenance order header
- QMEL — Notifications

## Recommended BAPIs & Classes
- BAPI_EQUI_CREATE — Create equipment
- BAPI_ALM_ORDER_MAINTAIN — Maintain PM order
- BAPI_ALM_NOTIF_CREATE — Create notification
- BAPI_FUNCLOC_CREATE — Create functional location

## Coding Guidelines
- PM orders: BAPI_ALM_ORDER_MAINTAIN (multi-step)
- Notifications: BAPI_ALM_NOTIF_* family
- Classification: BAPI_CLASSIFICATION_*
- Measurement documents: MEASUREM_DOCUM_RFC_SINGLE_001

## Common Errors
- Missing partner maintenance on orders
- Status network not respected
- Equipment hierarchy built incorrectly

## S/4HANA Migration
- Asset Management integration
- CDS Views: I_MaintenanceOrder, I_FunctionalLocation`,

  QM: `# SAP QM (Quality Management) — Best Practices

## Important Tables & Structures
- QALS — Inspection lots
- QASR — Sample results
- QAVE — Usage decisions
- QMEL — Quality notifications
- QMFE — Defects/causes

## Recommended BAPIs & Classes
- BAPI_QUALNOT_CREATE — Create quality notification
- BAPI_INSPLOT_GETLIST — Read inspection lots
- QM_INSPECTION_LOT_CREATE — Create inspection lot

## Coding Guidelines
- Do not manually create inspection lots if automatic lot opening is configured
- Usage decisions: use standard workflow
- Consistently maintain catalogs for defect types

## Common Errors
- Inspection point assignment in routings forgotten
- QM authorizations too restrictive/too open
- Missing dynamic modification rules for sampling

## S/4HANA Migration
- Embedded QM in S/4HANA Manufacturing
- CDS Views: I_InspectionLot, I_QualityNotification`,

  HR: `# SAP HR/HCM (Human Capital Management) — Best Practices

## Important Tables & Structures
- PA0001-PA0999 — HR master infotypes
- HRP1000/HRP1001 — OM objects/relationships
- PCL1/PCL2 — Payroll clusters
- PERNR — Personnel number (central entity)

## Recommended BAPIs & Classes
- HR_READ_INFOTYPE — Read infotype (standard FM)
- HR_INFOTYPE_OPERATION — Maintain infotype (INSS/MOD/DEL)
- RH_READ_OBJECT — Read OM objects
- CL_HR_PA_REQUEST_API — PA actions (newer API)

## Coding Guidelines
- Infotypes: ALWAYS use HR_READ_INFOTYPE / MACROS (RP-READ-INFOTYPE)
- NEVER write directly to PA tables!
- Authorizations: check HR auth via PERNR + INFTY + SUBTY
- Use logical database PNP/PNPCE for reports
- Time management: customize schemas via PCRs, do not hard-code

## Common Errors
- SELECT on PA tables without BEGDA/ENDDA logic
- Reading cluster tables (PCL*) directly instead of via macros
- Missing consideration of validity periods
- MOLGA-dependent logic not accounted for

## S/4HANA Migration
- SAP SuccessFactors for cloud HCM
- On-premise: HCM for S/4HANA (compatibility package)
- Employee Central as master for master data`,

  PS: `# SAP PS (Project System) — Best Practices

## Important Tables & Structures
- PROJ — Project definition
- PRPS — WBS elements
- AUFK — PS networks/orders
- AFVC — Operations
- BPGE/BPJA — Budget values

## Recommended BAPIs & Classes
- BAPI_PS_INITIALIZATION — Initialize PS APIs
- BAPI_PS_CREATE_WBS_ELEMENT — Create WBS element
- BAPI_NETWORK_MAINTAIN — Maintain network
- BAPI_PROJECT_MAINTAIN — Maintain project

## Coding Guidelines
- PS APIs always in buffer mode (INIT → operations → SAVE)
- Project hierarchy: build top-down
- Budget: via BAPIs, not directly on BPGE
- Scheduling: use standard scheduling functions

## Common Errors
- BAPI_PS_PRECOMMIT before BAPI_TRANSACTION_COMMIT forgotten
- Hierarchy levels mixed up
- Status profile not considered

## S/4HANA Migration
- Commercial Project Management (CPM)
- CDS Views: I_Project, I_WBSElement`,

  WM: `# SAP WM/EWM (Warehouse Management) — Best Practices

## Important Tables & Structures
- LQUA — Quants (warehouse stock)
- LTAP/LTAK — Transfer orders
- LAGP — Storage bins
- T300/T301 — Warehouse/storage type customizing
- LEIN — Handling units

## Recommended BAPIs & Classes
- BAPI_WHSE_TO_CREATE_STOCK — Create transfer order
- L_TO_CREATE_MOVE_SU — TO for handling unit
- BAPI_WHSE_STOCK_GET_LIST — Read stock

## Coding Guidelines
- Transfer orders: always via BAPIs/standard function modules
- Storage bin determination: configure putaway strategies, do not hard-code
- Inventory: use standard transactions MI*/LI*

## Common Errors
- Directly modifying quant table (LQUA)
- Missing confirmation of transfer orders
- WM-MM integration: stock differences due to missing TO confirmation

## S/4HANA Migration
- WM → EWM (embedded or decentralized)
- Stock Room Management as simpler alternative
- EWM: /SCWM/ namespace, CDS Views available`,

  EWM: `# SAP EWM (Extended Warehouse Management) — Best Practices

## Important Tables & Structures
- /SCWM/AQUA — Quants
- /SCWM/ORDIM_O — Warehouse Tasks
- /SCWM/LAGP — Storage Bins
- /SCWM/WHO — Warehouse Orders

## Recommended Classes
- /SCWM/CL_WM_PACKING — Packing logic
- /SCWM/CL_SR_BOM — BOMs in warehouse
- PPF (Post Processing Framework) for automation

## Coding Guidelines
- BAdIs for process customization (e.g. /SCWM/EX_HUOPT)
- Create warehouse tasks via standard APIs
- Use RF framework for mobile dialogs

## Common Errors
- Direct table manipulation instead of using APIs
- EWM-ERP integration: IDoc processing not monitored
- Missing exception handling for /SCWM/ APIs

## S/4HANA Migration
- Embedded EWM available directly in S/4HANA
- Decentralized EWM for complex scenarios`,

  BASIS: `# SAP BASIS/BC — Best Practices

## Important Tables & Structures
- USR02 — User master
- TVARVC — Selection variables
- TBTCO/TBTCP — Job overview
- E070/E071 — Transports
- TADIR — Object catalog

## Recommended Classes & FMs
- CL_LOG_PPF — Application Log
- BAL_LOG_CREATE / BAL_LOG_MSG_ADD — Application Log (classic)
- JOB_OPEN / JOB_SUBMIT / JOB_CLOSE — Background processing
- CL_BCS — Business Communication Services (e-mail)
- CL_GUI_FRONTEND_SERVICES — File up/download

## Coding Guidelines
- Logging: use Application Log (BAL) or CL_LOG_PPF, not WRITE
- Jobs: JOB_OPEN/SUBMIT/CLOSE for background processing
- Authorizations: AUTHORITY-CHECK always with specific objects
- Configuration: TVARVC for variable parameters instead of hard-coding
- Locks: Enqueue/Dequeue FMs for own lock objects

## Common Errors
- AUTHORITY-CHECK forgotten or too generic
- Lock objects not released (Enqueue without Dequeue)
- Hard-coded client/system numbers
- COMMIT WORK in update-task FMs

## S/4HANA Migration
- ABAP Platform: cloud-capable ABAP
- Respect released APIs (whitelist)
- CL_ABAP_CONTEXT_INFO instead of SY-UNAME/SY-DATUM directly`,

  ABAP: `# ABAP — General Best Practices

## Clean ABAP Principles
- Inline declarations: DATA(lv_var), FIELD-SYMBOL(<fs>)
- String templates: |Text { lv_var }| instead of CONCATENATE
- NEW #() / VALUE #() / CONV #() — constructor expressions
- COND #() / SWITCH #() instead of IF/CASE for assignments
- REDUCE #() for aggregations
- FILTER #() instead of LOOP + IF

## Modern ABAP SQL
- SELECT ... INTO TABLE @DATA(lt_result) — host variables with @
- SELECT ... FROM ... JOIN — instead of FOR ALL ENTRIES
- CDS Views for complex queries
- ABAP SQL aggregations instead of ABAP LOOP + COLLECT

## OOP Guidelines
- Classes/interfaces instead of function modules for new logic
- Dependency injection via interfaces (testability)
- Respect SOLID principles
- Exceptions: CX_* classes, TRY/CATCH instead of SY-SUBRC

## Performance
- SELECT only required fields, never SELECT *
- Internal tables: SORTED/HASHED TABLE for frequent access
- PARALLEL CURSOR for nested LOOPs
- Buffering: configure table buffering, use single-record buffer
- FOR ALL ENTRIES: check for duplicates and empty table!

## Avoiding Obsolete Statements
- MOVE → = (assignment)
- COMPUTE → direct calculation
- CHECK in methods → IF + RETURN
- FORM/PERFORM → methods
- Header-line tables → separate work area

## Testability
- ABAP Unit: CL_ABAP_UNIT_ASSERT
- Test doubles: CL_ABAP_TESTDOUBLE
- Test seams: IF_OSQL_TEST_ENVIRONMENT for DB
- SQL Test Double Framework

## S/4HANA Compatibility
- Check released APIs (whitelist approach)
- Use CL_ABAP_CONTEXT_INFO
- RAP (RESTful ABAP Programming) for new apps
- CDS Views as central data models`,
};

// Aliases: HCM → HR, BC → BASIS
MODULE_BEST_PRACTICES["HCM"] = MODULE_BEST_PRACTICES["HR"];
MODULE_BEST_PRACTICES["BC"] = MODULE_BEST_PRACTICES["BASIS"];
