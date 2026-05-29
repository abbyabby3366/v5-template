/// Baccarat Simulator — Standard Punto Banco Rules
/// No burn card. 8-deck shoe. Reshuffles when shoe runs low.
///
/// Card values:
///   A = 1, 2–9 = face value, T/J/Q/K = 0
///
/// Player draws on 0–5, stands on 6–7, natural on 8–9.
/// Banker drawing depends on the player's third card (see banker_draws()).

use std::collections::HashMap;
use std::cmp::Ordering;
use rayon::prelude::*;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

mod baccarat;

// ─── Constants ────────────────────────────────────────────────────────────────

const NUM_DECKS: usize = 8;
const RESHUFFLE_THRESHOLD: usize = 52; // stop shoe when fewer than 52 cards remain
const MAX_ROUNDS_PER_SHOE: usize = 60; // hard cap: max rounds dealt per shoe
const NUM_SHOES: u64 = 1_000_000;      // number of shoes to simulate
const ANALYZER_SHOES: u64 = 10_000;    // shoes used for the per-hand EV analyzer
const BETTING_SHOES: u64  = 1_000_000;    // shoes for betting sim (uses exact EV, so keep it small)

// ─── Mode selection ───────────────────────────────────────────────────────────
// Set either or both to true. Analyzer is slower — reduce ANALYZER_SHOES if needed.
const RUN_SIMULATION: bool = false;
const RUN_ANALYZER:   bool = false;
const RUN_BETTING_SIM: bool = true;

// ─── Betting Simulation Parameters ────────────────────────────────────────────
const STARTING_BANKROLL: f64 = 1_000_000.0;
const MIN_EV_THRESHOLD: f64 = 0.0003;   // +0.06%
const REBATE_RATE: f64 = 0.012;         // 1.2% on effective turnover

#[allow(dead_code)]
#[derive(PartialEq)]
enum BetMethod {
    Flat,
    Kelly,
}

const BET_METHOD: BetMethod = BetMethod::Kelly; // choose Flat or Kelly
const FLAT_RATIO: f64 = 0.002;
const KELLY_RATIO: f64 = 0.5;
const MAX_BET_RATIO: f64 = 0.05; // max bet cap relative to bankroll

// ─── Card & Shoe ──────────────────────────────────────────────────────────────

/// Build a fresh 8-deck shoe (416 cards).
/// Each card is represented as its rank (0–12).
fn build_shoe() -> Vec<u8> {
    let mut shoe = Vec::with_capacity(NUM_DECKS * 52);
    for _ in 0..NUM_DECKS {
        for rank in 0u8..13 {
            for _ in 0..4 {
                // 4 suits per rank
                shoe.push(rank);
            }
        }
    }
    shoe
}

/// A simple Linear Congruential Generator (no external crates needed).
struct Lcg {
    state: u64,
}

impl Lcg {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        // Numerical Recipes parameters
        self.state = self
            .state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.state
    }

    /// Random usize in [0, n)
    fn next_usize(&mut self, n: usize) -> usize {
        (self.next_u64() as usize) % n
    }
}

/// Fisher-Yates shuffle using our LCG.
fn shuffle(shoe: &mut Vec<u8>, rng: &mut Lcg) {
    let n = shoe.len();
    for i in (1..n).rev() {
        let j = rng.next_usize(i + 1);
        shoe.swap(i, j);
    }
}

// ─── Hand logic ───────────────────────────────────────────────────────────────

/// Baccarat hand total (always mod 10).
fn hand_total(cards: &[u8]) -> u8 {
    let sum: u8 = cards.iter().map(|&r| baccarat::card_value(r)).sum();
    sum % 10
}

// ─── Round result ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Outcome {
    Player,
    Banker,
    Tie,
}

/// Play one round of baccarat. Returns the Outcome.
/// Cards are stored as rank integers (0–12); use rank_name() to display them.
fn play_round(shoe: &mut Vec<u8>, cursor: &mut usize) -> Outcome {
    // Helper: deal one card from the shoe
    let deal = |shoe: &mut Vec<u8>, cursor: &mut usize| -> u8 {
        let card = shoe[*cursor];
        *cursor += 1;
        card
    };

    // Initial deal: P1 B1 P2 B2
    let mut player = vec![deal(shoe, cursor), deal(shoe, cursor)];
    let mut banker = vec![deal(shoe, cursor), deal(shoe, cursor)];

    let p_total = hand_total(&player);
    let b_total = hand_total(&banker);

    // ── Natural: stop immediately ──
    if p_total >= 8 || b_total >= 8 {
        return determine_winner(hand_total(&player), hand_total(&banker));
    }

    // ── Player third card ──
    let player_third: Option<u8> = if baccarat::player_draws(p_total) {
        let card = deal(shoe, cursor);
        player.push(card);
        Some(baccarat::card_value(card))
    } else {
        None
    };

    // ── Banker third card ──
    if baccarat::banker_draws(b_total, player_third) {
        let card = deal(shoe, cursor);
        banker.push(card);
    }

    determine_winner(hand_total(&player), hand_total(&banker))
}

fn determine_winner(p: u8, b: u8) -> Outcome {
    match p.cmp(&b) {
        Ordering::Greater => Outcome::Player,
        Ordering::Less    => Outcome::Banker,
        Ordering::Equal   => Outcome::Tie,
    }
}

fn compute_hand_probs(shoe: &[u8], cursor: usize) -> (f64, f64, f64) {
    let remaining = &shoe[cursor..];

    // Count remaining cards by baccarat value (0–9)
    let mut c = [0i32; 10];
    for &rank in remaining {
        c[baccarat::card_value(rank) as usize] += 1;
    }

    let probs = baccarat::compute_probs_from_counts(&c);
    (probs.p_player, probs.p_banker, probs.p_tie)
}

/// Runs ANALYZER_SHOES shoes, computing exact pre-hand EV before every hand.
/// Reports the EV distribution for Banker and Player bets
/// on an effective-turnover basis (ties = push, not counted as turnover).
fn run_analyzer(rng: &mut Lcg) {
    println!("\n=== Pre-hand EV Analyzer ===");
    println!("Shoes: {ANALYZER_SHOES} | Rounds/shoe: {MAX_ROUNDS_PER_SHOE} | EV basis: effective turnover (tie = push)\n");

    // EV tracking variables
    const BUCKETS: usize = 25;
    const BUCKET_START: f64 = -0.025; // -2.5%
    const BUCKET_WIDTH: f64 =  0.001; //  0.1%

    let shoe_seeds: Vec<u64> = (0..ANALYZER_SHOES).map(|_| rng.next_u64()).collect();
    let completed_shoes = AtomicUsize::new(0);

    let results: Vec<_> = shoe_seeds.into_par_iter().map(|shoe_seed| {
        let mut local_rng = Lcg::new(shoe_seed);
        
        let mut shoe_total_hands = 0;
        let mut bk_sum = 0.0;
        let mut bk_sum_sq = 0.0;
        let mut bk_min = f64::MAX;
        let mut bk_max = f64::MIN;
        let mut pl_sum = 0.0;
        let mut pl_sum_sq = 0.0;
        let mut pl_min = f64::MAX;
        let mut pl_max = f64::MIN;
        let mut bk_histogram = [0u64; BUCKETS];
        let mut pl_histogram = [0u64; BUCKETS];

        let mut shoe = build_shoe();
        shuffle(&mut shoe, &mut local_rng);
        let mut cursor = 0usize;
        let mut rounds_this_shoe = 0usize;

        while shoe.len() - cursor >= RESHUFFLE_THRESHOLD
            && rounds_this_shoe < MAX_ROUNDS_PER_SHOE
        {
            let (pp, pb, _pt) = compute_hand_probs(&shoe, cursor);
            let non_tie = pp + pb;

            if non_tie == 0.0 {
                play_round(&mut shoe, &mut cursor);
                rounds_this_shoe += 1;
                continue;
            }

            let ev_player = (pp - pb) / non_tie;
            let ev_banker = (pb * 0.95 - pp) / non_tie;

            bk_sum += ev_banker;
            bk_sum_sq += ev_banker * ev_banker;
            bk_min = bk_min.min(ev_banker);
            bk_max = bk_max.max(ev_banker);

            pl_sum += ev_player;
            pl_sum_sq += ev_player * ev_player;
            pl_min = pl_min.min(ev_player);
            pl_max = pl_max.max(ev_player);

            let bk_bucket = ((ev_banker - BUCKET_START) / BUCKET_WIDTH) as isize;
            if bk_bucket >= 0 && (bk_bucket as usize) < BUCKETS {
                bk_histogram[bk_bucket as usize] += 1;
            }

            let pl_bucket = ((ev_player - BUCKET_START) / BUCKET_WIDTH) as isize;
            if pl_bucket >= 0 && (pl_bucket as usize) < BUCKETS {
                pl_histogram[pl_bucket as usize] += 1;
            }

            shoe_total_hands += 1;
            rounds_this_shoe += 1;
            play_round(&mut shoe, &mut cursor);
        }

        let current = completed_shoes.fetch_add(1, AtomicOrdering::Relaxed) + 1;
        let tenth = (ANALYZER_SHOES / 10).max(1) as usize;
        if current % tenth == 0 || current == ANALYZER_SHOES as usize {
            let percentage = (current as f64 / ANALYZER_SHOES as f64 * 100.0).round() as u64;
            let filled = (percentage / 10) as usize;
            let empty = 10 - filled;
            let bar = format!("[{}{}]", "█".repeat(filled), "░".repeat(empty));
            println!("Analyzer Progress: {} {:>3}% done ({} / {} shoes)", bar, percentage, current, ANALYZER_SHOES);
        }

        (shoe_total_hands, bk_sum, bk_sum_sq, bk_min, bk_max, pl_sum, pl_sum_sq, pl_min, pl_max, bk_histogram, pl_histogram)
    }).collect();

    // Aggregate
    let mut total_hands = 0;
    let mut bk_sum = 0.0;
    let mut bk_sum_sq = 0.0;
    let mut bk_min = f64::MAX;
    let mut bk_max = f64::MIN;
    let mut pl_sum = 0.0;
    let mut pl_sum_sq = 0.0;
    let mut pl_min = f64::MAX;
    let mut pl_max = f64::MIN;
    let mut bk_histogram = [0u64; BUCKETS];
    let mut pl_histogram = [0u64; BUCKETS];

    for res in results {
        total_hands += res.0;
        bk_sum += res.1;
        bk_sum_sq += res.2;
        bk_min = bk_min.min(res.3);
        bk_max = bk_max.max(res.4);
        pl_sum += res.5;
        pl_sum_sq += res.6;
        pl_min = pl_min.min(res.7);
        pl_max = pl_max.max(res.8);
        for i in 0..BUCKETS {
            bk_histogram[i] += res.9[i];
            pl_histogram[i] += res.10[i];
        }
    }

    let n = total_hands as f64;

    // Banker stats
    let bk_mean = bk_sum / n;
    let bk_std  = (bk_sum_sq / n - bk_mean * bk_mean).sqrt();

    // Player stats
    let pl_mean = pl_sum / n;
    let pl_std  = (pl_sum_sq / n - pl_mean * pl_mean).sqrt();

    println!("Pre-hand EV statistics over {total_hands} hands:");
    println!("─────────────────────────────────────────────────────────");
    println!("  {:10}  {:>10}  {:>10}  {:>10}  {:>10}", "Bet", "Mean EV", "Std Dev", "Min EV", "Max EV");
    println!("  {:10}  {:>10.4}  {:>10.4}  {:>10.4}  {:>10.4}", "Banker", bk_mean, bk_std, bk_min, bk_max);
    println!("  {:10}  {:>10.4}  {:>10.4}  {:>10.4}  {:>10.4}", "Player", pl_mean, pl_std, pl_min, pl_max);
    println!("─────────────────────────────────────────────────────────");

    // Histogram
    println!("\nBanker EV distribution (effective turnover basis):");
    println!("  {:<24}  {:>10}", "EV range", "% of hands");
    for i in 0..BUCKETS {
        let ev_lo = BUCKET_START + i as f64 * BUCKET_WIDTH;
        let ev_hi = ev_lo + BUCKET_WIDTH;
        let pct   = bk_histogram[i] as f64 / n * 100.0;
        if pct > 0.0 {
            println!("  [{:+.3} to {:+.3}):  {:6.2}%", ev_lo, ev_hi, pct);
        }
    }

    println!("\nPlayer EV distribution (effective turnover basis):");
    println!("  {:<24}  {:>10}", "EV range", "% of hands");
    for i in 0..BUCKETS {
        let ev_lo = BUCKET_START + i as f64 * BUCKET_WIDTH;
        let ev_hi = ev_lo + BUCKET_WIDTH;
        let pct   = pl_histogram[i] as f64 / n * 100.0;
        if pct > 0.0 {
            println!("  [{:+.3} to {:+.3}):  {:6.2}%", ev_lo, ev_hi, pct);
        }
    }
}

// ─── Simulation ───────────────────────────────────────────────────────────────

/// Runs NUM_SHOES full shoes and prints win rates + house edge statistics.
fn run_simulation(rng: &mut Lcg) {
    println!("=== Baccarat Simulator ===");
    println!("Decks: {NUM_DECKS} | Shoes: {NUM_SHOES} | No burn card\n");

    let mut counts: HashMap<Outcome, u64> = HashMap::new();
    let mut total_rounds: u64 = 0;

    for _ in 0..NUM_SHOES {
        let mut shoe = build_shoe();
        shuffle(&mut shoe, rng);
        let mut cursor = 0usize;
        let mut rounds_this_shoe = 0usize;

        while shoe.len() - cursor >= RESHUFFLE_THRESHOLD
            && rounds_this_shoe < MAX_ROUNDS_PER_SHOE
        {
            let outcome = play_round(&mut shoe, &mut cursor);
            *counts.entry(outcome).or_insert(0) += 1;
            total_rounds += 1;
            rounds_this_shoe += 1;
        }
    }

    // ── Results ──────────────────────────────────────────────────────────────
    let player_wins = counts.get(&Outcome::Player).copied().unwrap_or(0);
    let banker_wins = counts.get(&Outcome::Banker).copied().unwrap_or(0);
    let ties        = counts.get(&Outcome::Tie).copied().unwrap_or(0);

    let total = total_rounds as f64;
    let rounds_per_shoe = total / NUM_SHOES as f64;

    println!("Results after {NUM_SHOES} shoes ({total_rounds} total rounds, ~{rounds_per_shoe:.1} rounds/shoe):");
    println!("─────────────────────────────────────────");
    println!("  Player wins : {:>10}  ({:.4}%)", player_wins, player_wins as f64 / total * 100.0);
    println!("  Banker wins : {:>10}  ({:.4}%)", banker_wins, banker_wins as f64 / total * 100.0);
    println!("  Ties        : {:>10}  ({:.4}%)", ties,        ties        as f64 / total * 100.0);
    println!("─────────────────────────────────────────");

    let p_freq = player_wins as f64 / total;
    let b_freq = banker_wins as f64 / total;
    let tie_rate = ties as f64 / total;
    let non_tie_rate = (player_wins + banker_wins) as f64 / total;

    let non_tie = (player_wins + banker_wins) as f64;
    let p_rate = player_wins as f64 / non_tie;
    let b_rate = banker_wins as f64 / non_tie;

    println!("\nAmong non-tie rounds:");
    println!("  Player rate : {:.4}%", p_rate * 100.0);
    println!("  Banker rate : {:.4}%", b_rate * 100.0);

    let ev_player_all = p_freq * 1.0  - b_freq * 1.0;
    let ev_banker_all = b_freq * 0.95 - p_freq * 1.0;
    let ev_tie        = tie_rate * 8.0 - non_tie_rate * 1.0;
    let ev_player_notie = p_rate * 1.0  - b_rate * 1.0;
    let ev_banker_notie = b_rate * 0.95 - p_rate * 1.0;

    println!("\nExpected value per unit bet (total turnover):");
    println!("  Bet Player  : {:+.4}  (house edge: {:.4}%)", ev_player_all, -ev_player_all * 100.0);
    println!("  Bet Banker  : {:+.4}  (house edge: {:.4}%)", ev_banker_all, -ev_banker_all * 100.0);
    println!("  Bet Tie     : {:+.4}  (house edge: {:.4}%)  [8:1 payout]", ev_tie, -ev_tie * 100.0);

    println!("\nExpected value per unit bet (total effective turnover):");
    println!("  Bet Player  : {:+.4}  (house edge: {:.4}%)", ev_player_notie, -ev_player_notie * 100.0);
    println!("  Bet Banker  : {:+.4}  (house edge: {:.4}%)", ev_banker_notie, -ev_banker_notie * 100.0);
}

// ─── Betting Simulation ───────────────────────────────────────────────────────

struct ShoeStats {
    profit: f64,
    turnover: f64,
    effective_turnover: f64,
    expected_ev: f64,
    expected_base_ev: f64,
    rebate_earned: f64,
    bets_placed: u64,
    total_hands: u64,
    wins: u64,
    losses: u64,
    pushes: u64,
    banker_bets: u64,
    player_bets: u64,
}

/// Simulates a betting strategy using the pre-hand EV analyzer.
/// Applies the 1.2% rebate to the base EV to determine if the threshold is met.
fn run_betting_simulation(rng: &mut Lcg) {
    println!("=== Betting Simulation ===");
    println!("Starting Bankroll: ${STARTING_BANKROLL}");
    println!("Min EV Threshold: {MIN_EV_THRESHOLD} (+{:.2}%)", MIN_EV_THRESHOLD * 100.0);
    println!("Rebate Rate: {:.2}% on effective turnover", REBATE_RATE * 100.0);
    println!("Bet Method: {}", if BET_METHOD == BetMethod::Kelly { "Kelly (Static Bankroll)" } else { "Flat" });
    println!("Shoes: {BETTING_SHOES}\n");

    // Configure Rayon to use 3/4 of the available threads.
    // If not already configured in main, doing it here is a fallback.
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(std::thread::available_parallelism().map(|n| (n.get() * 3) / 4).unwrap_or(1).max(1))
        .build_global();

    // Pre-generate a unique seed for each shoe sequentially
    let shoe_seeds: Vec<u64> = (0..BETTING_SHOES).map(|_| rng.next_u64()).collect();

    // Setup an atomic counter for the progress bar
    let completed_shoes = AtomicUsize::new(0);

    // Map each shoe in parallel to its individual statistics
    let results: Vec<_> = shoe_seeds.into_par_iter().map(|shoe_seed| {
        // Create a local RNG for this thread's shoe
        let mut local_rng = Lcg::new(shoe_seed);
        
        let mut shoe_bankroll = 0.0; // Start at 0, tracking net profit for the shoe
        let mut shoe_turnover = 0.0;
        let mut shoe_effective_turnover = 0.0;
        let mut shoe_expected_ev = 0.0;
        let mut shoe_expected_base_ev = 0.0;
        let mut shoe_rebate_earned = 0.0;
        let mut shoe_bets_placed = 0;
        let mut shoe_total_hands = 0;
        let mut shoe_wins = 0;
        let mut shoe_losses = 0;
        let mut shoe_pushes = 0;
        let mut shoe_banker_bets = 0;
        let mut shoe_player_bets = 0;

        let mut shoe = build_shoe();
        shuffle(&mut shoe, &mut local_rng);
        let mut cursor = 0usize;
        let mut rounds_this_shoe = 0usize;

        while shoe.len() - cursor >= RESHUFFLE_THRESHOLD
            && rounds_this_shoe < MAX_ROUNDS_PER_SHOE
        {
            shoe_total_hands += 1;

            let (pp, pb, _pt) = compute_hand_probs(&shoe, cursor);
            let non_tie = pp + pb;
            
            if non_tie == 0.0 {
                play_round(&mut shoe, &mut cursor);
                rounds_this_shoe += 1;
                continue;
            }

            let ev_player_base = (pp - pb) / non_tie;
            let ev_banker_base = (pb * 0.95 - pp) / non_tie;

            let ev_player_adj = ev_player_base + REBATE_RATE;
            let ev_banker_adj = ev_banker_base + REBATE_RATE;

            let mut chosen_bet = None;
            let mut best_ev = 0.0;
            let mut variance = 1.0;

            if ev_player_adj > MIN_EV_THRESHOLD && ev_player_adj > ev_banker_adj {
                chosen_bet = Some(Outcome::Player);
                best_ev = ev_player_adj;
                variance = 1.0;
            } else if ev_banker_adj > MIN_EV_THRESHOLD && ev_banker_adj > ev_player_adj {
                chosen_bet = Some(Outcome::Banker);
                best_ev = ev_banker_adj;
                variance = (pb / non_tie) * (0.95 * 0.95) + (pp / non_tie) * 1.0;
            }

            let mut bet_size = 0.0;
            if chosen_bet.is_some() {
                let mut raw_bet_size = match BET_METHOD {
                    BetMethod::Flat => FLAT_RATIO * STARTING_BANKROLL,
                    BetMethod::Kelly => {
                        let kelly_fraction = best_ev / variance;
                        kelly_fraction * KELLY_RATIO * STARTING_BANKROLL
                    }
                };

                let max_bet_size = MAX_BET_RATIO * STARTING_BANKROLL;
                if raw_bet_size > max_bet_size {
                    raw_bet_size = max_bet_size;
                }

                bet_size = (raw_bet_size / 50.0).round() * 50.0;
                
                if bet_size <= 0.0 {
                    chosen_bet = None;
                } else {
                    shoe_expected_ev += bet_size * best_ev * non_tie;
                    
                    let base_ev = if chosen_bet == Some(Outcome::Player) { ev_player_base } else { ev_banker_base };
                    shoe_expected_base_ev += bet_size * base_ev * non_tie;
                    
                    if chosen_bet == Some(Outcome::Banker) { shoe_banker_bets += 1; }
                    else if chosen_bet == Some(Outcome::Player) { shoe_player_bets += 1; }
                }
            }

            let outcome = play_round(&mut shoe, &mut cursor);
            rounds_this_shoe += 1;

            if let Some(target) = chosen_bet {
                shoe_bets_placed += 1;
                shoe_turnover += bet_size;

                if outcome != Outcome::Tie {
                    shoe_effective_turnover += bet_size;
                    
                    let rebate = bet_size * REBATE_RATE;
                    shoe_rebate_earned += rebate;
                    shoe_bankroll += rebate;

                    if outcome == target {
                        shoe_wins += 1;
                        if target == Outcome::Banker {
                            shoe_bankroll += bet_size * 0.95;
                        } else {
                            shoe_bankroll += bet_size * 1.0;
                        }
                    } else {
                        shoe_losses += 1;
                        shoe_bankroll -= bet_size;
                    }
                } else {
                    shoe_pushes += 1;
                }
            }
        }
        
        // Progress tracking
        let current = completed_shoes.fetch_add(1, AtomicOrdering::Relaxed) + 1;
        let tenth = (BETTING_SHOES / 10).max(1) as usize;
        if current % tenth == 0 || current == BETTING_SHOES as usize {
            let percentage = (current as f64 / BETTING_SHOES as f64 * 100.0).round() as u64;
            // Print a simple progress bar
            let filled = (percentage / 10) as usize;
            let empty = 10 - filled;
            let bar = format!("[{}{}]", "█".repeat(filled), "░".repeat(empty));
            println!("Progress: {} {:>3}% done ({} / {} shoes)", bar, percentage, current, BETTING_SHOES);
        }

        ShoeStats {
            profit: shoe_bankroll,
            turnover: shoe_turnover,
            effective_turnover: shoe_effective_turnover,
            expected_ev: shoe_expected_ev,
            expected_base_ev: shoe_expected_base_ev,
            rebate_earned: shoe_rebate_earned,
            bets_placed: shoe_bets_placed,
            total_hands: shoe_total_hands,
            wins: shoe_wins,
            losses: shoe_losses,
            pushes: shoe_pushes,
            banker_bets: shoe_banker_bets,
            player_bets: shoe_player_bets,
        }
    }).collect();

    // Aggregate results from all threads sequentially to calculate max drawdown
    let mut current_profit = 0.0;
    let mut max_drawdown = 0.0;
    
    let mut stats = ShoeStats {
        profit: 0.0, turnover: 0.0, effective_turnover: 0.0,
        expected_ev: 0.0, expected_base_ev: 0.0, rebate_earned: 0.0,
        bets_placed: 0, total_hands: 0, wins: 0, losses: 0, pushes: 0,
        banker_bets: 0, player_bets: 0,
    };

    for res in results {
        stats.profit += res.profit;
        stats.turnover += res.turnover;
        stats.effective_turnover += res.effective_turnover;
        stats.expected_ev += res.expected_ev;
        stats.expected_base_ev += res.expected_base_ev;
        stats.rebate_earned += res.rebate_earned;
        stats.bets_placed += res.bets_placed;
        stats.total_hands += res.total_hands;
        stats.wins += res.wins;
        stats.losses += res.losses;
        stats.pushes += res.pushes;
        stats.banker_bets += res.banker_bets;
        stats.player_bets += res.player_bets;
        
        current_profit += res.profit;
        if current_profit < max_drawdown {
            max_drawdown = current_profit;
        }
    }
    
    let bankroll = STARTING_BANKROLL + stats.profit;

    // ── Results ──────────────────────────────────────────────────────────────
    println!("Simulation Complete!");
    println!("─────────────────────────────────────────");
    println!("Total Hands Dealt:    {}", stats.total_hands);
    println!("Total Bets Placed:    {} ({:.2}% of hands)", stats.bets_placed, (stats.bets_placed as f64 / stats.total_hands as f64) * 100.0);
    println!("  - Banker Bets:      {} ({:.1}%)", stats.banker_bets, (stats.banker_bets as f64 / stats.bets_placed as f64) * 100.0);
    println!("  - Player Bets:      {} ({:.1}%)", stats.player_bets, (stats.player_bets as f64 / stats.bets_placed as f64) * 100.0);
    println!("Outcome Breakdown:");
    println!("  - Wins:             {} ({:.1}%)", stats.wins, (stats.wins as f64 / stats.bets_placed as f64) * 100.0);
    println!("  - Losses:           {} ({:.1}%)", stats.losses, (stats.losses as f64 / stats.bets_placed as f64) * 100.0);
    println!("  - Pushes:           {} ({:.1}%)", stats.pushes, (stats.pushes as f64 / stats.bets_placed as f64) * 100.0);
    
    let avg_bet = if stats.bets_placed > 0 { stats.turnover / stats.bets_placed as f64 } else { 0.0 };
    println!("Average Bet Size:     ${avg_bet:.2}");
    println!("Total Turnover:       ${:.2}", stats.turnover);
    println!("Effective Turnover:   ${:.2}", stats.effective_turnover);
    println!("Total Rebate Earned:  ${:.2}", stats.rebate_earned);
    println!("─────────────────────────────────────────");
    let actual_loss = stats.profit - stats.rebate_earned;
    let yield_without_rebate = (actual_loss / stats.effective_turnover.max(1.0)) * 100.0;
    let base_house_edge = (stats.expected_base_ev / stats.effective_turnover.max(1.0)) * 100.0;
    
    println!("Actual Game Loss:     ${actual_loss:+.2} (excluding rebate)");
    let yield_color = if yield_without_rebate > base_house_edge { "\x1b[32m" } else { "\x1b[31m" };
    println!("{yield_color}Game Yield (ROI):     {yield_without_rebate:+.4}%\x1b[0m");
    println!("Avg Base House Edge:  {base_house_edge:+.4}% (Formula: sum of [bet_size * Base EV * non_tie_prob])");
    println!("─────────────────────────────────────────");
    println!("Starting Bankroll:    ${STARTING_BANKROLL:.2}");
    println!("Ending Bankroll:      ${bankroll:.2}");
    println!("\x1b[33mNet Profit w/ Rebate: ${:+.2}\x1b[0m", stats.profit);
    println!("\x1b[38;5;208mNet Yield on Eff T.O: {:+.4}%\x1b[0m \x1b[97m({:.2}% rebate + Game Yield)\x1b[0m", (stats.profit / stats.effective_turnover.max(1.0)) * 100.0, REBATE_RATE * 100.0);
    println!("─────────────────────────────────────────");
    let theoretical_yield = if stats.effective_turnover > 0.0 {
        (stats.expected_ev / stats.effective_turnover) * 100.0
    } else {
        0.0
    };
    println!("\x1b[33mExpected Net Profit:  ${:+.2}\x1b[0m (Formula: sum of [bet_size * Actual EV * non_tie_prob])", stats.expected_ev);
    println!("\x1b[38;5;208mExpected EV (Yield):  {:+.4}%\x1b[0m", theoretical_yield);
    println!("─────────────────────────────────────────");
    println!("=== Risk & Drawdown Analysis ===");
    let base_stdev = avg_bet * ((stats.bets_placed as f64) * 0.94).sqrt();
    let sigma_3_risk = 3.0 * base_stdev;
    let sigma_2_risk = 2.0 * base_stdev;
    let sigma_90_risk = 1.645 * base_stdev;
    let sigma_1_risk = 1.0 * base_stdev;
    println!("Max Drawdown:         ${max_drawdown:.2} ({:.2}% of start bankroll)", (max_drawdown / STARTING_BANKROLL) * 100.0);
    println!("3-Sigma Worst Dip:    $-{sigma_3_risk:.2} (99.7% confidence bound for {} bets)", stats.bets_placed);
    println!("2-Sigma Worst Dip:    $-{sigma_2_risk:.2} (95.4% confidence bound for {} bets)", stats.bets_placed);
    println!("1.645-Sigma Dip:      $-{sigma_90_risk:.2} (90.0% confidence bound for {} bets)", stats.bets_placed);
    println!("1-Sigma Dip:          $-{sigma_1_risk:.2} (68.3% confidence bound for {} bets)", stats.bets_placed);
}

fn main() {
    // Generate a random seed based on the current system time
    let seed = 123456789;
    let mut rng = Lcg::new(seed);

    // Configure Rayon to use 3/4 of the available threads.
    let num_threads = std::thread::available_parallelism().map(|n| (n.get() * 3) / 4).unwrap_or(1).max(1);
    let _ = rayon::ThreadPoolBuilder::new().num_threads(num_threads).build_global();

    println!("Configured thread pool with {} threads.", num_threads);

    if RUN_SIMULATION {
        run_simulation(&mut rng);
    }

    if RUN_ANALYZER {
        run_analyzer(&mut rng);
    }

    if RUN_BETTING_SIM {
        run_betting_simulation(&mut rng);
    }
}
