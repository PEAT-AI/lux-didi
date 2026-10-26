-- Diagnostic queries: one named SELECT per question, metadata only unless the query says otherwise.
--
-- Start with the CLI views, not with these: they merge the logs and the store into one ordered print, and
-- they count what they could not attribute instead of guessing.
--   node scripts/didi-timeline call <liveSessionId|latest> [--content]
--       one call's story: owner and model turns, tool calls with ms and outcome, research phases, silences
--       with their cause, connector events and the terminal, across host.log (and its rotated files),
--       native-live.log, audio.log and state.sqlite. Every line says how it joined the call: by callId,
--       by liveSessionId, or by the pid and time window of that session's own lines. --content is off by
--       default and is the only way owner text reaches the print.
--   node scripts/didi-timeline doctor
--       log health: files, bytes, lines, torn lines, top events, oldest and newest day, and the lines that
--       name neither a session nor a call.
--   node scripts/didi-timeline list
--       recent calls: start, duration, tool calls, longest silence, terminal.
-- The two queries below are the store half those views read.
-- name: live_sessions
SELECT live_session_id,created_at,lifecycle,terminal_outcome,journal_complete,
       diagnostic_metadata_state,diagnostic_content_state,native_receipt_state,
       diagnostic_failures,diagnostic_last_reason
FROM live_sessions ORDER BY created_at DESC;

-- name: chat_runs
SELECT run_id,session_id,user_entry_id,final_entry_id,state,outcome,
       accepted_at,intent_at,terminal_at,partial_truncated
FROM chat_runs WHERE session_id=:conversation ORDER BY accepted_at,rowid;

-- name: transcript_fragments
SELECT journal_id,provider_sequence,connection_epoch,kind,text,finished,final_origin,
       provider_event_id,provider_start_ms,provider_end_ms,arrived_at,received_mono_ms,
       clock_domain,finalized_at,finalized_mono_ms
FROM live_journal WHERE live_session_id=:session
  AND kind IN ('inputTranscription','outputTranscription') ORDER BY journal_id;

-- name: canonical_calls
SELECT execution_id,call_id,json_extract(intent_json,'$.toolName') AS tool,
       state,input_fidelity,input_json,input_sha256,input_key_count,
       result_id,result_sha256,result_json
FROM tool_calls WHERE run_id=:run ORDER BY execution_id;

-- name: source_dispatches
SELECT execution_id,ordinal,dispatch_id,connector,endpoint_id,tool_name,generation,
       binding_digest,schema_digest,policy_sha256,run_snapshot_sha256,
       source_policy_id,source_policy_revision,session_class,session_revision,source_class,
       arguments_fidelity,arguments_json,arguments_sha256,arguments_key_count,
       state,reason,source_outcome,wire_state,started_at,started_mono_ms,clock_domain,
       wire_at,wire_mono_ms,wire_clock_domain,completed_at,completed_mono_ms,completed_clock_domain,
       CASE WHEN clock_domain=completed_clock_domain AND completed_mono_ms>=started_mono_ms
            THEN completed_mono_ms-started_mono_ms END AS attempt_to_seal_ms,
       entity_sha256,entity_bytes,source_sha256,source_bytes,source_json
FROM tool_dispatches WHERE run_id=:run ORDER BY execution_id,ordinal;

-- name: source_text_parts
SELECT d.execution_id,d.ordinal,d.dispatch_id,p.key AS part_index,
       json_extract(p.value,'$.text') AS text
FROM tool_dispatches d,json_each(d.source_json,'$.content') p
WHERE d.run_id=:run AND d.state='completed' ORDER BY d.execution_id,d.ordinal,CAST(p.key AS INTEGER);

-- name: accepted_source_identity
SELECT d.dispatch_id,d.connector,d.endpoint_id,d.connection_id,d.generation,
       d.binding_digest,d.schema_digest,d.policy_sha256,d.run_snapshot_sha256,
       r.snapshot_sha256 AS accepted_snapshot_sha256
FROM tool_dispatches d JOIN tool_runs r ON r.owner_id=d.owner_id AND r.run_id=d.run_id
WHERE d.run_id=:run ORDER BY d.execution_id,d.ordinal;

-- name: source_reuse
SELECT execution_id,id,origin_dispatch_id,state,reason,observed_at
FROM tool_dispatch_reuse WHERE run_id=:run ORDER BY observed_at,id;

-- name: capture_coverage
SELECT execution_id,kind,reason,observed_at FROM tool_dispatch_coverage
WHERE run_id=:run ORDER BY observed_at,id;

-- name: unassociated_host_coverage
SELECT kind,reason,count(*) AS observations FROM tool_dispatch_coverage
WHERE run_id IS NULL GROUP BY kind,reason;

-- name: tool_trace_stages
SELECT call_key,kind,at,mono_ms,clock_domain,response_key,turn_id,connection_epoch
FROM trace_event WHERE live_session_id=:session
  AND kind IN ('call.intent','call.executed','call.output_prepared','call.output_written') ORDER BY seq;

-- name: playback_receipts
SELECT playback_key,source_instance_id,segment_seq,response_key,turn_id,
       received_at,enqueued_at,started_at,audible_at,drained_at,interrupted_at,termination_reason
FROM trace_playback WHERE live_session_id=:session ORDER BY segment_seq,received_at;

-- name: memory_links
SELECT e.id,e.session_id,e.role,e.sequence,s.provider,s.external_id,s.availability
FROM entries e LEFT JOIN source_references s ON s.owner_kind='entry' AND s.owner_id=e.id
WHERE e.session_id=:conversation ORDER BY e.sequence,s.id;

-- name: history_dependencies
SELECT h.live_session_id,h.data_class,h.revision,d.parent_session_id,d.parent_revision
FROM history_sessions h LEFT JOIN history_dependencies d ON d.child_session_id=h.live_session_id
WHERE h.live_session_id=:session ORDER BY d.parent_session_id;

-- name: call_timeline
-- The store half of `didi-timeline call`: one session's turns, responses, tool calls and playback in one
-- ordered set, wall clock with the positional mono_ms as the tiebreak.
SELECT 'turn' AS kind, t.turn_index AS ordinal, t.opened_at AS at, t.mono_ms AS mono_ms,
       t.origin AS detail, t.outcome AS outcome, NULL AS ms, NULL AS name
  FROM trace_turn t WHERE t.live_session_id=:session
UNION ALL
SELECT 'response', 0, r.created_at, NULL, r.status, r.terminal_reason, NULL, NULL
  FROM trace_response r WHERE r.live_session_id=:session
UNION ALL
SELECT 'call', 0, c.intent_at, NULL, c.outcome, c.outcome, c.ms, c.name
  FROM trace_call c WHERE c.live_session_id=:session
UNION ALL
SELECT 'playback', p.segment_seq, p.received_at, NULL, p.termination_reason, NULL, NULL, p.source_instance_id
  FROM trace_playback p WHERE p.live_session_id=:session
ORDER BY at, mono_ms, kind;

-- name: call_owner_content
-- The content half of `didi-timeline call --content`: utterance text and research question/web query text
-- for one session. Content class C lives here and never in a log, which is why this query is separate.
SELECT 'utterance' AS kind, t.turn_index AS ordinal, u.role AS detail, u.at AS at, u.final AS final, u.text AS text
  FROM trace_utterance u JOIN trace_turn t ON t.turn_id=u.turn_id WHERE t.live_session_id=:session
UNION ALL
SELECT 'research', 0, x.kind, x.at, NULL, x.text
  FROM trace_research_text x
  WHERE x.research_id IN (SELECT research_id FROM trace_call WHERE live_session_id=:session AND research_id IS NOT NULL)
ORDER BY at;
