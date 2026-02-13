import 'dotenv/config';
import { connectToWhatsApp, setOnStabilityCallback } from './connection';
import { initSupabase } from './supabase';
import { setupMessageHandler } from './messageHandler';
import { startApiServer } from './api';
import { startShabbatLocker, stopShabbatLocker } from './shabbatLocker';
import { startDailySummary, stopDailySummary } from './features/daily-summary';
import { startJoinRequestScheduler, stopJoinRequestScheduler } from './features/join-request-scheduler';
import { processPendingResponses } from './features/mention-response';

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log(`[${new Date().toISOString()}] WhatsApp Message Logger Starting...`);
  console.log('='.repeat(60));

  // Initialize Supabase
  try {
    initSupabase();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to initialize Supabase:`, err);
    process.exit(1);
  }

  // Register callback to process pending responses when connection becomes stable
  // This ensures landing page URLs that couldn't be delivered due to connection issues
  // will be sent when the connection is restored
  setOnStabilityCallback(async () => {
    await processPendingResponses();
  });

  // Start API server
  startApiServer();

  // Start Shabbat/Holiday locker service
  startShabbatLocker();

  // Start Daily Summary scheduler
  startDailySummary();

  // Start Join Request Auto-Processing scheduler
  startJoinRequestScheduler();

  // Connect to WhatsApp
  try {
    await connectToWhatsApp((sock) => {
      setupMessageHandler(sock);
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to connect to WhatsApp:`, err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Received SIGINT. Shutting down gracefully...`);
  stopShabbatLocker();
  stopDailySummary();
  stopJoinRequestScheduler();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n[${new Date().toISOString()}] Received SIGTERM. Shutting down gracefully...`);
  stopShabbatLocker();
  stopDailySummary();
  stopJoinRequestScheduler();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, err);
  // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection at:`, promise, 'reason:', reason);
  // Don't exit - try to keep running
});

// Start the application
main().catch((err) => {
  console.error(`[${new Date().toISOString()}] Fatal error:`, err);
  process.exit(1);
});
