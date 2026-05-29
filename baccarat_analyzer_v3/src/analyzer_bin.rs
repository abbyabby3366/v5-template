use std::env;

mod baccarat;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 14 {
        eprintln!("Usage: {} <A> <2> <3> <4> <5> <6> <7> <8> <9> <T> <J> <Q> <K>", args[0]);
        eprintln!("  Each argument = remaining count for that rank in the shoe.");
        std::process::exit(1);
    }

    // Parse 13-slot composition: [A, 2, 3, 4, 5, 6, 7, 8, 9, T, J, Q, K]
    let mut r = [0i32; 13];
    for i in 0..13 {
        r[i] = args[i + 1].parse().expect("Invalid card count");
    }

    // Collapse 13-slot ranks → 10-slot baccarat values for probability engine
    // Baccarat values: A=1, 2=2, ..., 9=9, T/J/Q/K=0
    let mut c = [0i32; 10];
    c[1] = r[0];           // A → value 1
    for i in 1..=8 {
        c[i + 1] = r[i];   // 2→val2, 3→val3, ..., 9→val9
    }
    c[0] = r[9] + r[10] + r[11] + r[12]; // T+J+Q+K → value 0

    let probs = baccarat::compute_probs_from_counts(&c);
    println!("{}", serde_json::to_string(&probs).unwrap());
}
