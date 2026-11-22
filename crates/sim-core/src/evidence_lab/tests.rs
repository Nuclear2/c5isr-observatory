use super::*;

fn config(fork: Option<u32>, ids: Option<&[&str]>) -> LabConfig {
    LabConfig {
        fork_tick: fork,
        cited_ids: ids.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
        ..LabConfig::default()
    }
}

#[test]
fn default_run_distinguishes_relay_from_independent_report_and_receipt_from_read() {
    let archive = run_lab(&LabConfig::default()).unwrap();
    assert_eq!(archive.fork_tick, 6);
    let frame = &archive.immediate.frames[6];
    assert_eq!(frame.reports.len(), 3);
    assert_eq!(frame.reports[1].derived_from.as_deref(), Some("R1"));
    assert_eq!(frame.reports[0].root_id, frame.reports[1].root_id);
    assert_eq!(frame.reports[2].received_tick, 6);
    assert_eq!(frame.reports[2].read_tick, None);
    assert_eq!(frame.queue_ids, ["R3"]);
    assert_eq!(frame.active_ids, ["R1", "R2"]);
    assert_eq!(frame.independent_roots, ["R1"]);
    assert!(!frame.conflict);
    let decision = &frame.decisions[0];
    assert_eq!(decision.claim, "normal");
    assert_eq!(decision.evidence_ids, ["R1", "R2"]);
    assert_eq!(decision.read_ids, ["R1", "R2"]);
    assert_eq!(decision.independent_roots, ["R1"]);
    let read = &archive.immediate.frames[9];
    assert!(read.conflict);
    assert_eq!(read.independent_roots, ["R1", "R3"]);
    assert_eq!(read.metrics.conflict_ticks, 1);
    assert_eq!(read.decisions, frame.decisions);
}

#[test]
fn corrections_retire_derived_copies_without_rewriting_the_original_approval() {
    let experiment = run_lab(&config(None, Some(&["R2"]))).unwrap();
    let immediate = &experiment.immediate;
    assert_eq!(immediate.frames[17].metrics.corrected_approvals, 0);
    assert!(
        immediate.frames[17]
            .reports
            .iter()
            .all(|report| report.id != "R4")
    );
    let corrected = &immediate.frames[18];
    assert!(!corrected.conflict);
    assert_eq!(corrected.active_ids, ["R3", "R4"]);
    assert_eq!(
        corrected.reports.last().unwrap().revises.as_deref(),
        Some("R1")
    );
    assert_eq!(corrected.metrics.corrected_approvals, 1);
    assert_eq!(corrected.decisions[0].evidence_ids, ["R2"]);
    assert_eq!(corrected.decisions[0].actor, "human");
    assert_eq!(corrected.decisions[0].claim, "normal");
    assert_eq!(corrected.decisions, immediate.frames[6].decisions);
    assert_eq!(corrected.reports[1].claim, "normal");
    assert_eq!(immediate.metrics.conflict_ticks, 9);
    assert_eq!(immediate.metrics.review_requests, 0);
    let review = &experiment.review;
    assert_eq!(review.frames[11].reports[3].id, "R5");
    assert_eq!(review.frames[11].reports[3].read_tick, None);
    assert!(review.frames[11].conflict);
    assert_eq!(review.frames[12].decisions[1].claim, "interrupted");
    assert_eq!(review.frames[12].decisions[1].evidence_ids, ["R3", "R5"]);
    assert_eq!(review.metrics.conflict_ticks, 3);
    assert_eq!(review.metrics.corrected_approvals, 0);
    assert_eq!(review.metrics.review_requests, 1);
}

#[test]
fn forks_copy_the_entire_prefix_and_share_external_receipts_even_as_the_queue_changes() {
    for seed in [0, 20_261_022, u32::MAX] {
        for interval in 1..=6 {
            let settings = LabConfig {
                seed,
                read_interval: interval,
                ..LabConfig::default()
            };
            let archive = run_lab(&settings).unwrap();
            let fork = archive.fork_tick as usize;
            assert_eq!(
                archive.immediate.frames[..fork],
                archive.review.frames[..fork]
            );
            for (a, b) in archive.immediate.frames.iter().zip(&archive.review.frames) {
                assert_eq!(a.tick, b.tick);
                // A branch may compete for the reader but cannot change shared delivery.
                let normalize = |reports: &[LabReport]| {
                    reports
                        .iter()
                        .filter(|r| r.id != "R5")
                        .map(|r| LabReport {
                            read_tick: None,
                            ..r.clone()
                        })
                        .collect::<Vec<_>>()
                };
                assert_eq!(normalize(&a.reports), normalize(&b.reports));
                for frame in [a, b] {
                    assert!(frame.reports.iter().all(|r| {
                        r.received_tick <= frame.tick
                            && r.issued_tick <= r.received_tick
                            && r.period_end <= r.issued_tick
                            && r.read_tick
                                .is_none_or(|at| r.received_tick <= at && at <= frame.tick)
                    }));
                    let pending: Vec<_> = frame
                        .reports
                        .iter()
                        .filter(|r| r.read_tick.is_none())
                        .map(|r| &r.id)
                        .collect();
                    assert!(pending.iter().copied().eq(&frame.queue_ids));
                    assert!(
                        frame
                            .reports
                            .iter()
                            .filter(|r| r.read_tick == Some(frame.tick))
                            .count()
                            <= 1
                    );
                    for d in &frame.decisions {
                        assert!(d.tick <= frame.tick);
                        assert!(d.evidence_ids.iter().all(|id| d.read_ids.contains(id)));
                        assert!(
                            d.read_ids.iter().all(|id| frame
                                .reports
                                .iter()
                                .any(|r| &r.id == id
                                    && r.read_tick.is_some_and(|read| read <= d.tick)))
                        );
                    }
                }
            }
            for run in [&archive.immediate, &archive.review] {
                assert_eq!(run.metrics, run.frames.last().unwrap().metrics);
                assert!(run.frames.last().unwrap().queue_ids.is_empty());
            }
        }
    }
}

#[test]
fn invalid_and_stale_approval_requests_do_not_create_a_comparison() {
    for settings in [
        config(Some(0), None),
        config(Some(37), None),
        config(Some(2), None),
        config(None, Some(&[])),
        config(None, Some(&["R2", "R2"])),
        config(None, Some(&["R6"])),
        config(None, Some(&["R3"])),
        config(None, Some(&["R4"])),
        config(Some(18), Some(&["R2"])),
        LabConfig {
            read_interval: 0,
            ..LabConfig::default()
        },
        LabConfig {
            read_interval: 7,
            ..LabConfig::default()
        },
    ] {
        assert!(run_lab(&settings).is_err(), "{settings:?}");
    }
    let later = run_lab(&config(Some(18), Some(&["R3", "R4"]))).unwrap();
    assert_eq!(later.immediate.frames[18].decisions[0].claim, "interrupted");
    let conflict = run_lab(&config(Some(9), Some(&["R3", "R2"]))).unwrap();
    assert_eq!(
        conflict.immediate.frames[9].decisions[0].claim,
        "undetermined"
    );
    let late = run_lab(&LabConfig {
        read_interval: 6,
        ..config(Some(36), None)
    })
    .unwrap();
    assert_eq!(late.review.frames.last().unwrap().decisions.len(), 2);
    assert!(late.review.frames.last().unwrap().queue_ids.is_empty());
}

#[test]
fn repeated_runs_and_each_batch_row_match_the_corresponding_seed() {
    let base = LabConfig::default();
    assert_eq!(run_lab(&base).unwrap(), run_lab(&base).unwrap());
    let rows = run_batch(&base, 8).unwrap();
    for (offset, row) in rows.iter().enumerate() {
        assert_eq!(row.seed, base.seed + offset as u32);
        let archive = run_lab(&LabConfig {
            seed: row.seed,
            ..base.clone()
        })
        .unwrap();
        assert_eq!(row.immediate, archive.immediate.metrics);
        assert_eq!(row.review, archive.review.metrics);
    }
    assert!(rows.windows(2).any(|r| r[0].immediate != r[1].immediate));
    assert!(run_batch(&base, 0).is_err());
    assert!(run_batch(&base, 33).is_err());
    assert!(run_batch(&config(None, Some(&["R1"])), 2).is_err());
    let last = LabConfig {
        seed: u32::MAX,
        ..base
    };
    assert!(run_batch(&last, 2).is_err());
    assert_eq!(run_batch(&last, 1).unwrap()[0].seed, u32::MAX);
}
