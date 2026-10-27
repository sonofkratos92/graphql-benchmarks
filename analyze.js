#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const FORMATTED_SERVER_NAMES = {
  tailcall: "Tailcall",
  gqlgen: "Gqlgen",
  apollo: "Apollo GraphQL",
  netflixdgs: "Netflix DGS",
  caliban: "Caliban",
  async_graphql: "async-graphql",
  hasura: "Hasura",
  graphql_jit: "GraphQL JIT",
};

const SERVERS = [
  "apollo",
  "caliban",
  "netflixdgs",
  "gqlgen",
  "tailcall",
  "async_graphql",
  "hasura",
  "graphql_jit",
];

const BENCH_QUERIES = {
  1: "{ posts { id userId title user { id name email }}}",
  2: "{ posts { title }}",
  3: "{ greet }",
};

function extractMetricFromContent(content, metric) {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes(metric)) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length >= 2) {
        const cleaned = tokens[1].replace(/ms$/i, "");
        const parsed = parseFloat(cleaned);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
  }
  return 0;
}

function extractMetric(filePath, metric) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const content = fs.readFileSync(filePath, "utf8");
  return extractMetricFromContent(content, metric);
}

function average(values) {
  if (!values || values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, v) => acc + Number(v || 0), 0);
  return sum / values.length;
}

function formatNumber(num) {
  const fixed = Number(num || 0).toFixed(2);
  const [intPart, decPart] = fixed.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withCommas}.${decPart}`;
}

function ensureGnuplotInstalled() {
  try {
    execSync("gnuplot --version", { stdio: "ignore" });
  } catch {
    try {
      execSync("sudo apt-get update && sudo apt-get install -y gnuplot", {
        stdio: "inherit",
      });
    } catch {
      // Ignore if running in an environment without apt-get
    }
  }
}

function generateHistograms(whichBench, avgReqSecs, avgLatencies) {
  const reqSecData = "/tmp/reqSec.dat";
  const latencyData = "/tmp/latency.dat";

  const reqSecLines = ["Server Value"];
  const latencyLines = ["Server Value"];
  for (const server of SERVERS) {
    reqSecLines.push(`${server} ${avgReqSecs[server]}`);
    latencyLines.push(`${server} ${avgLatencies[server]}`);
  }

  fs.writeFileSync(reqSecData, reqSecLines.join("\n") + "\n", "utf8");
  fs.writeFileSync(latencyData, latencyLines.join("\n") + "\n", "utf8");

  const reqSecHistogramFile = `req_sec_histogram${whichBench}.png`;
  const latencyHistogramFile = `latency_histogram${whichBench}.png`;

  const gnuplotScript = `
    set term pngcairo size 1280,720 enhanced font "Courier,12"
    set output "${reqSecHistogramFile}"
    set style data histograms
    set style histogram cluster gap 1
    set style fill solid border -1
    set xtics rotate by -45
    set boxwidth 0.9
    set title "Requests/Sec"
    stats "${reqSecData}" using 2 nooutput
    set yrange [0:STATS_max*1.2]
    set key outside right top
    plot "${reqSecData}" using 2:xtic(1) title "Req/Sec"

    set output "${latencyHistogramFile}"
    set title "Latency (in ms)"
    stats "${latencyData}" using 2 nooutput
    set yrange [0:STATS_max*1.2]
    plot "${latencyData}" using 2:xtic(1) title "Latency"
  `;

  ensureGnuplotInstalled();
  try {
    execSync("gnuplot", { input: gnuplotScript, stdio: ["pipe", "inherit", "inherit"] });
    fs.mkdirSync("assets", { recursive: true });
    if (fs.existsSync(reqSecHistogramFile)) {
      fs.renameSync(reqSecHistogramFile, path.join("assets", reqSecHistogramFile));
    }
    if (fs.existsSync(latencyHistogramFile)) {
      fs.renameSync(latencyHistogramFile, path.join("assets", latencyHistogramFile));
    }
  } catch (err) {
    console.warn("Warning: gnuplot execution skipped or failed:", err.message);
  }
}

function buildResultsTable(whichBench, avgReqSecs, avgLatencies) {
  const sortedServers = [...SERVERS].sort(
    (a, b) => (avgReqSecs[b] || 0) - (avgReqSecs[a] || 0)
  );
  console.log("Sorted servers:", sortedServers.join(" "));

  const lastServer = sortedServers[sortedServers.length - 1];
  const lastServerReqSecs = avgReqSecs[lastServer] || 1;

  let resultsTable = "";
  if (whichBench === 1) {
    resultsTable = [
      "<!-- PERFORMANCE_RESULTS_START -->",
      "",
      "| Query | Server | Requests/sec | Latency (ms) | Relative |",
      "|-------:|--------:|--------------:|--------------:|---------:|",
      `| ${whichBench} | \`${BENCH_QUERIES[1]}\` |`,
    ].join("\n");
  } else if (whichBench === 2) {
    resultsTable = `| ${whichBench} | \`${BENCH_QUERIES[2]}\` |`;
  } else if (whichBench === 3) {
    resultsTable = `| ${whichBench} | \`${BENCH_QUERIES[3]}\` |`;
  }

  for (const server of sortedServers) {
    const formattedReqSecs = formatNumber(avgReqSecs[server]);
    const formattedLatencies = formatNumber(avgLatencies[server]);
    const relativePerformance = (
      (avgReqSecs[server] || 0) / (lastServerReqSecs || 1)
    ).toFixed(2);
    resultsTable += `\n|| [${FORMATTED_SERVER_NAMES[server]}] | \`${formattedReqSecs}\` | \`${formattedLatencies}\` | \`${relativePerformance}x\` |`;
  }

  if (whichBench === 3) {
    resultsTable += "\n\n<!-- PERFORMANCE_RESULTS_END -->";
  }

  return resultsTable;
}

function updateReadmeWithResults(resultsFile, readmePath = "README.md") {
  if (!fs.existsSync(resultsFile) || !fs.existsSync(readmePath)) {
    return;
  }
  const finalResults = fs.readFileSync(resultsFile, "utf8").trimEnd();
  console.log(
    finalResults
      .replace("<!-- PERFORMANCE_RESULTS_START -->", "")
      .replace("<!-- PERFORMANCE_RESULTS_END -->", "")
  );

  const readmeContent = fs.readFileSync(readmePath, "utf8");
  const startMarker = "<!-- PERFORMANCE_RESULTS_START -->";
  const endMarker = "<!-- PERFORMANCE_RESULTS_END -->";

  if (readmeContent.includes(startMarker) && readmeContent.includes(endMarker)) {
    const updated = readmeContent.replace(
      new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`),
      finalResults
    );
    fs.writeFileSync(readmePath, updated, "utf8");
  } else {
    fs.writeFileSync(readmePath, `${readmeContent}\n${finalResults}\n`, "utf8");
  }
}

function analyzeBenchmark(resultFiles, options = {}) {
  const avgReqSecs = {};
  const avgLatencies = {};

  SERVERS.forEach((server, idx) => {
    const startIdx = idx * 3;
    const reqSecVals = [];
    const latencyVals = [];
    for (let j = 0; j < 3; j++) {
      const file = resultFiles[startIdx + j];
      reqSecVals.push(extractMetric(file, "Requests/sec"));
      latencyVals.push(extractMetric(file, "Latency"));
    }
    avgReqSecs[server] = average(reqSecVals);
    avgLatencies[server] = average(latencyVals);
  });

  const firstFile = path.basename(resultFiles[0] || "");
  let whichBench = 1;
  if (firstFile.startsWith("bench2")) {
    whichBench = 2;
  } else if (firstFile.startsWith("bench3")) {
    whichBench = 3;
  }

  if (!options.skipPlot) {
    generateHistograms(whichBench, avgReqSecs, avgLatencies);
  }

  const resultsTable = buildResultsTable(whichBench, avgReqSecs, avgLatencies);
  console.log("resultsTable:", resultsTable);

  const resultsFile = options.resultsFile || "results.md";
  fs.appendFileSync(resultsFile, resultsTable + "\n", "utf8");

  if (whichBench === 3) {
    updateReadmeWithResults(resultsFile, options.readmePath || "README.md");
  }

  if (!options.keepFiles) {
    for (const file of resultFiles) {
      if (file && fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  }

  return { whichBench, avgReqSecs, avgLatencies, resultsTable };
}

function buildBenchFileList(bench) {
  const files = [];
  for (const service of SERVERS) {
    let fileService = service;
    if (service === "apollo") fileService = "apollo_server";
    if (service === "netflixdgs") fileService = "netflix_dgs";
    for (const run of [1, 2, 3]) {
      files.push(`bench${bench}_result${run}_graphql_${fileService}_run.sh.txt`);
    }
  }
  return files;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    analyzeBenchmark(args);
  } else {
    if (fs.existsSync("results.md")) {
      fs.unlinkSync("results.md");
    }
    for (const bench of [1, 2, 3]) {
      console.log(`Processing files for bench${bench}:`);
      analyzeBenchmark(buildBenchFileList(bench));
    }
  }
}

module.exports = {
  FORMATTED_SERVER_NAMES,
  SERVERS,
  extractMetricFromContent,
  extractMetric,
  average,
  formatNumber,
  buildResultsTable,
  updateReadmeWithResults,
  analyzeBenchmark,
  buildBenchFileList,
};
