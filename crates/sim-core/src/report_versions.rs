use super::{Engine, Observation};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// One edition of a source's synthetic own-network status report. Both desks
/// refer to the same observation ID, even if only one copy arrives.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ReportVersion {
    pub source_id: String,
    pub version: u64,
    pub report_id: String,
    pub sampled_tick: u64,
    pub proposal_id: Option<String>,
    pub field_received_tick: Option<u64>,
    pub center_received_tick: Option<u64>,
}

impl Engine {
    pub(super) fn issue_report_version(
        &mut self,
        observation: &Observation,
        proposal_id: Option<&str>,
    ) {
        // The most recently issued version survives window trimming.
        let version = self
            .state
            .report_versions
            .iter()
            .rev()
            .find(|row| row.source_id == observation.source_id)
            .map_or(1, |row| row.version + 1);
        // Seeded samples are present in both inboxes when the scenario opens.
        let initial_receipt = proposal_id.is_none().then_some(self.state.tick);
        // Freeze the readout for this source and sample. A relay later quotes
        // that edition, including any readout error.
        let claim = super::strategy_study::edition_claim(
            self.state.seed,
            &observation.source_id,
            observation.observed_tick,
        );
        self.edition_claims.insert(observation.id.clone(), claim);
        self.state.report_versions.push(ReportVersion {
            source_id: observation.source_id.clone(),
            version,
            report_id: observation.id.clone(),
            sampled_tick: observation.observed_tick,
            proposal_id: proposal_id.map(str::to_owned),
            field_received_tick: initial_receipt,
            center_received_tick: initial_receipt,
        });
    }

    pub(super) fn deliver_field_copies(&mut self) {
        // The synthetic local path delivers one step after sampling, independently
        // of the uplink. Only an advanced clock can create a field receipt.
        for report in self.state.report_versions.iter_mut().rev() {
            if report.sampled_tick < self.state.tick - 1 {
                break;
            }
            if report.field_received_tick.is_none() {
                report.field_received_tick = Some(self.state.tick);
            }
        }
    }

    pub(super) fn record_center_receipt(&mut self, observation: &Observation) {
        let report = self
            .state
            .report_versions
            .iter_mut()
            .rev()
            .find(|row| row.report_id == observation.id)
            .expect("every queued supplementary sample has a retained report version");
        // Delayed older editions keep their own actual time; consumers choose the
        // greatest version received by each desk at the replay tick.
        report
            .center_received_tick
            .get_or_insert(observation.received_tick);
    }

    pub(super) fn prune_report_versions(&mut self) {
        let oldest = self.state.history.first().map_or(0, |frame| frame.tick);
        if oldest == 0 {
            return;
        }
        #[derive(Default)]
        struct BeforeWindow {
            issued: u64,
            field: u64,
            center: u64,
        }
        let mut before = HashMap::<String, BeforeWindow>::new();
        // Rows are in issue order. Keep the versions selected at the left edge
        // even if a newer edition is still in transit or was permanently lost.
        for report in self
            .state
            .report_versions
            .iter()
            .take_while(|row| row.sampled_tick < oldest)
        {
            let boundary = before.entry(report.source_id.clone()).or_default();
            boundary.issued = report.version;
            if report.field_received_tick.is_some_and(|tick| tick < oldest) {
                boundary.field = report.version;
            }
            if report
                .center_received_tick
                .is_some_and(|tick| tick < oldest)
            {
                boundary.center = report.version;
            }
        }
        let in_transit: HashSet<&str> = self
            .queue
            .iter()
            .filter(|message| message.proposal_id.is_some())
            .map(|message| message.observation.id.as_str())
            .collect();
        self.state.report_versions.retain(|row| {
            let keep = row.sampled_tick >= oldest
                || row.field_received_tick.is_none()
                || row.field_received_tick.is_some_and(|tick| tick >= oldest)
                || row.center_received_tick.is_some_and(|tick| tick >= oldest)
                || in_transit.contains(row.report_id.as_str())
                || before.get(&row.source_id).is_some_and(|boundary| {
                    [boundary.issued, boundary.field, boundary.center].contains(&row.version)
                });
            if !keep {
                self.edition_claims.remove(&row.report_id);
            }
            keep
        });
    }
}
