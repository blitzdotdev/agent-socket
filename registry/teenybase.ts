import {DatabaseSettings, sql, sqlValue, TableData, TableRulesExtensionData} from 'teenybase'
import {baseFields, createdTrigger, updatedTrigger} from 'teenybase/scaffolds/fields'

// agent-socket tool registry.
//
// All writes go through the worker's own routes (src/), never through the
// generic teenybase CRUD API. Every table therefore carries a `rules`
// extension: a table without one is open to anonymous CRUD. `null` rules deny
// everything except admin tokens (ADMIN_SERVICE_TOKEN, used by `teeny exec`).
const denyAll: TableRulesExtensionData = {
    name: 'rules',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
}

/** One row per approved website. `version` points at the live row set in `tools`/`site_versions`. */
const sites: TableData = {
    name: 'sites',
    fields: [
        ...baseFields,
        {name: 'host', type: 'text', sqlType: 'text', notNull: true, unique: true},
        {name: 'notes', type: 'editor', sqlType: 'text', notNull: true, default: sqlValue('')},
        {name: 'version', type: 'integer', sqlType: 'integer', notNull: true, default: sqlValue(0)},
        {
            name: 'status', type: 'select', sqlType: 'text', notNull: true, default: sqlValue('published'),
            check: sql`status IN ('published', 'unpublished')`,
        },
        {name: 'tool_count', type: 'integer', sqlType: 'integer', notNull: true, default: sqlValue(0)},
        // Denormalised "path description" lines of the live, enabled tools so a
        // single FTS index covers hosts, notes and tools.
        {name: 'tool_index', type: 'text', sqlType: 'text', notNull: true, default: sqlValue('')},
    ],
    indexes: [{fields: 'status'}],
    fullTextSearch: {
        fields: ['host', 'notes', 'tool_index'],
        // 'porter' = FTS5 porter stemmer over the default unicode61 tokenizer: "posting" matches "post"; `_`, `.`, `/`
        // are separators so `/sheets_write_range` indexes as sheets/write/range.
        tokenize: 'porter',
    },
    triggers: [createdTrigger, updatedTrigger],
    extensions: [{
        ...denyAll,
        // Approved, published profiles are public data anyway (served by GET /v1/sites/:host).
        listRule: "status == 'published'",
        viewRule: "status == 'published'",
    } as TableRulesExtensionData],
}

/** Append-only history: one row per approved version of a site. */
const siteVersions: TableData = {
    name: 'site_versions',
    fields: [
        ...baseFields,
        {name: 'site_id', type: 'relation', sqlType: 'text', notNull: true, foreignKey: {table: 'sites', column: 'id', onDelete: 'CASCADE'}},
        {name: 'version', type: 'integer', sqlType: 'integer', notNull: true},
        {name: 'notes', type: 'editor', sqlType: 'text', notNull: true, default: sqlValue('')},
        {name: 'tool_count', type: 'integer', sqlType: 'integer', notNull: true, default: sqlValue(0)},
        // Canonical hash of {host, notes, tools}; used for "no changes" and seed idempotency.
        {name: 'payload_hash', type: 'text', sqlType: 'text', notNull: true},
        // NOT NULL is load-bearing: the approve batch fills this from a guarded
        // sub-select, so a submission that is no longer pending aborts the batch.
        {name: 'submission_id', type: 'relation', sqlType: 'text', notNull: true, unique: true, foreignKey: {table: 'submissions', column: 'id'}},
        {name: 'approved_by', type: 'text', sqlType: 'text', notNull: true, default: sqlValue('')},
    ],
    indexes: [{fields: ['site_id', 'version'], unique: true}],
    triggers: [createdTrigger, updatedTrigger],
    extensions: [denyAll],
}

/** Tool definitions, one row per (site, version, method, path). Old versions are kept for history. */
const tools: TableData = {
    name: 'tools',
    fields: [
        ...baseFields,
        {name: 'site_id', type: 'relation', sqlType: 'text', notNull: true, foreignKey: {table: 'sites', column: 'id', onDelete: 'CASCADE'}},
        {name: 'version', type: 'integer', sqlType: 'integer', notNull: true},
        {name: 'position', type: 'integer', sqlType: 'integer', notNull: true, default: sqlValue(0)},
        {name: 'method', type: 'text', sqlType: 'text', notNull: true, default: sqlValue('POST')},
        {name: 'path', type: 'text', sqlType: 'text', notNull: true},
        {name: 'description', type: 'text', sqlType: 'text', notNull: true},
        {name: 'input_schema', type: 'json', sqlType: 'json', check: sql`input_schema IS NULL OR json_valid(input_schema)`},
        {name: 'code', type: 'text', sqlType: 'text', notNull: true},
        // Admin "unpublish this tool" switch for the live version.
        {name: 'disabled', type: 'bool', sqlType: 'boolean', notNull: true, default: sqlValue(false)},
    ],
    indexes: [{fields: ['site_id', 'version', 'method', 'path'], unique: true}],
    triggers: [createdTrigger, updatedTrigger],
    extensions: [denyAll],
}

/** Alternate hostnames that resolve to a canonical site host (twitter.com -> x.com). */
const siteAliases: TableData = {
    name: 'site_aliases',
    fields: [
        ...baseFields,
        {name: 'alias', type: 'text', sqlType: 'text', notNull: true, unique: true},
        {name: 'host', type: 'text', sqlType: 'text', notNull: true},
    ],
    indexes: [{fields: 'host'}],
    triggers: [createdTrigger, updatedTrigger],
    extensions: [denyAll],
}

/** Use counter, kept out of `sites` so GET traffic doesn't churn the FTS index / updated column. */
const siteStats: TableData = {
    name: 'site_stats',
    fields: [
        {name: 'site_id', type: 'relation', sqlType: 'text', primary: true, notNull: true, foreignKey: {table: 'sites', column: 'id', onDelete: 'CASCADE'}},
        {name: 'use_count', type: 'integer', sqlType: 'integer', notNull: true, default: sqlValue(0)},
        {name: 'last_used', type: 'date', sqlType: 'timestamp'},
    ],
    extensions: [denyAll],
}

/** Proposed profiles (anonymous, via POST /v1/submissions, or the seed import). Never auto-approved. */
const submissions: TableData = {
    name: 'submissions',
    fields: [
        ...baseFields,
        {name: 'host', type: 'text', sqlType: 'text', notNull: true},
        {name: 'kind', type: 'select', sqlType: 'text', notNull: true, check: sql`kind IN ('new', 'update')`},
        // Full proposed profile: {host, notes, tools: [{method, path, description, input_schema, code}]}
        {name: 'payload', type: 'json', sqlType: 'json', notNull: true, check: sql`json_valid(payload)`},
        {name: 'payload_hash', type: 'text', sqlType: 'text', notNull: true},
        {
            name: 'status', type: 'select', sqlType: 'text', notNull: true, default: sqlValue('pending'),
            check: sql`status IN ('pending', 'approved', 'rejected')`,
        },
        {name: 'review_note', type: 'text', sqlType: 'text'},
        {name: 'reviewed_at', type: 'date', sqlType: 'timestamp'},
        {name: 'reviewed_by', type: 'text', sqlType: 'text'},
        // Site version the submitter saw (0 = site did not exist). Approval may happen later.
        {name: 'base_version', type: 'integer', sqlType: 'integer', notNull: true, default: sqlValue(0)},
        {name: 'approved_version', type: 'integer', sqlType: 'integer'},
        {
            name: 'source', type: 'select', sqlType: 'text', notNull: true, default: sqlValue('api'),
            check: sql`source IN ('api', 'import')`,
        },
        // Submitter info. The IP is never stored: only an HMAC with IP_HASH_SECRET.
        {name: 'ip_hash', type: 'text', sqlType: 'text'},
        {name: 'user_agent', type: 'text', sqlType: 'text'},
        {name: 'ext_version', type: 'text', sqlType: 'text'},
    ],
    indexes: [
        {fields: ['status', 'created']},
        {fields: 'host'},
        {fields: ['ip_hash', 'created']},
        // At most one *pending* submission per identical payload (dedupe, race-safe).
        {name: 'uq_submissions_pending_payload', fields: 'payload_hash', unique: true, where: {q: "status = 'pending'"}},
    ],
    triggers: [createdTrigger, updatedTrigger],
    extensions: [denyAll],
}

export default {
    appName: 'agent-socket registry',
    appUrl: 'https://registry.agentsocket.dev',
    // Required by teenybase for its admin tokens. No user auth tables exist here.
    jwtSecret: '$JWT_SECRET',
    tables: [sites, submissions, siteVersions, tools, siteAliases, siteStats],
} satisfies DatabaseSettings
