use std::collections::{HashMap, VecDeque};

#[derive(Default)]
pub struct Lanes {
    lanes: HashMap<u64, VecDeque<f32>>,
}

impl Lanes {
    pub fn push(&mut self, lane: u64, samples: &[f32]) {
        self.lanes.entry(lane).or_default().extend(samples.iter().copied());
    }

    pub fn remove(&mut self, lane: u64) {
        self.lanes.remove(&lane);
    }

    pub fn drain(&mut self) -> Vec<f32> {
        let length = self.lanes.values().map(VecDeque::len).max().unwrap_or(0);
        let mut mixed = vec![0.0f32; length];
        for lane in self.lanes.values_mut() {
            for (slot, sample) in mixed.iter_mut().zip(lane.drain(..)) {
                *slot += sample;
            }
        }
        for sample in mixed.iter_mut() {
            *sample = sample.clamp(-1.0, 1.0);
        }
        mixed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_every_lane_and_pads_the_shorter_ones() {
        let mut lanes = Lanes::default();
        lanes.push(1, &[0.1, 0.2, 0.3]);
        lanes.push(2, &[0.5]);
        let mixed = lanes.drain();
        assert_eq!(mixed.len(), 3);
        assert!((mixed[0] - 0.6).abs() < 1e-6);
        assert!((mixed[2] - 0.3).abs() < 1e-6);
        assert!(lanes.drain().is_empty());
    }

    #[test]
    fn keeps_the_sum_inside_the_valid_range() {
        let mut lanes = Lanes::default();
        lanes.push(1, &[0.9]);
        lanes.push(2, &[0.9]);
        assert_eq!(lanes.drain(), vec![1.0]);
    }

    #[test]
    fn forgets_a_lane_that_was_removed() {
        let mut lanes = Lanes::default();
        lanes.push(1, &[0.4]);
        lanes.remove(1);
        assert!(lanes.drain().is_empty());
    }
}
