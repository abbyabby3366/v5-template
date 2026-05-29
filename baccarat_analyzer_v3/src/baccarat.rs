use std::cmp::Ordering;
use serde::Serialize;

#[allow(dead_code)]
pub fn card_value(rank: u8) -> u8 {
    match rank {
        0 => 1,
        1..=8 => rank + 1,
        _ => 0,
    }
}

pub fn player_draws(total: u8) -> bool {
    total <= 5
}

pub fn banker_draws(banker_total: u8, player_third_card: Option<u8>) -> bool {
    match player_third_card {
        None => banker_total <= 5,
        Some(p3) => match banker_total {
            0 | 1 | 2 => true,
            3 => p3 != 8,
            4 => matches!(p3, 2..=7),
            5 => matches!(p3, 4..=7),
            6 => matches!(p3, 6 | 7),
            7 => false,
            _ => false,
        },
    }
}

#[derive(Default, Serialize, Debug, Clone)]
pub struct HandProbs {
    pub p_player: f64,
    pub p_banker: f64,
    pub p_tie: f64,
}

#[inline]
fn accumulate_detailed(
    pt: u8, bt: u8, prob: f64,
    probs: &mut HandProbs
) {
    match pt.cmp(&bt) {
        Ordering::Greater => probs.p_player += prob,
        Ordering::Less => probs.p_banker += prob,
        Ordering::Equal => probs.p_tie += prob,
    }
}

pub fn compute_probs_from_counts(c: &[i32; 10]) -> HandProbs {
    let n: i32 = c.iter().sum();
    let mut probs = HandProbs::default();

    if n < 4 {
        return probs;
    }



    // Enumerate P1, B1, P2, B2 by baccarat value
    for vp1 in 0..10usize {
        if c[vp1] == 0 { continue; }
        let pr1 = c[vp1] as f64 / n as f64;
        let mut c1 = *c; c1[vp1] -= 1; let n1 = n - 1;

        for vb1 in 0..10usize {
            if c1[vb1] == 0 { continue; }
            let pr2 = c1[vb1] as f64 / n1 as f64;
            let mut c2 = c1; c2[vb1] -= 1; let n2 = n1 - 1;

            for vp2 in 0..10usize {
                if c2[vp2] == 0 { continue; }
                let pr3 = c2[vp2] as f64 / n2 as f64;
                let mut c3 = c2; c3[vp2] -= 1; let n3 = n2 - 1;

                for vb2 in 0..10usize {
                    if c3[vb2] == 0 { continue; }
                    let base = pr1 * pr2 * pr3 * (c3[vb2] as f64 / n3 as f64);
                    let mut c4 = c3; c4[vb2] -= 1; let n4 = n3 - 1;

                    let pt = ((vp1 + vp2) % 10) as u8;
                    let bt = ((vb1 + vb2) % 10) as u8;

                    // Natural — no third cards
                    if pt >= 8 || bt >= 8 {
                        accumulate_detailed(pt, bt, base, &mut probs);
                        continue;
                    }

                    if player_draws(pt) {
                        // Player draws 3rd card
                        for vp3 in 0..10usize {
                            if c4[vp3] == 0 { continue; }
                            let pr5 = c4[vp3] as f64 / n4 as f64;
                            let mut c5 = c4; c5[vp3] -= 1; let n5 = n4 - 1;
                            let pt_final = (pt + vp3 as u8) % 10;

                            if banker_draws(bt, Some(vp3 as u8)) {
                                // Banker also draws
                                for vb3 in 0..10usize {
                                    if c5[vb3] == 0 { continue; }
                                    let bt_final = (bt + vb3 as u8) % 10;
                                    let prob = base * pr5 * (c5[vb3] as f64 / n5 as f64);
                                    accumulate_detailed(pt_final, bt_final, prob, &mut probs);
                                }
                            } else {
                                // Banker stands
                                accumulate_detailed(pt_final, bt, base * pr5, &mut probs);
                            }
                        }
                    } else {
                        // Player stands
                        if banker_draws(bt, None) {
                            // Banker draws
                            for vb3 in 0..10usize {
                                if c4[vb3] == 0 { continue; }
                                let bt_final = (bt + vb3 as u8) % 10;
                                let prob = base * (c4[vb3] as f64 / n4 as f64);
                                accumulate_detailed(pt, bt_final, prob, &mut probs);
                            }
                        } else {
                            // Both stand
                            accumulate_detailed(pt, bt, base, &mut probs);
                        }
                    }
                }
            }
        }
    }

    probs
}
