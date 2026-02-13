#!/usr/bin/env ts-node
/**
 * Manual Join Request Processor
 * Run this to immediately process pending join requests without waiting for scheduled time
 *
 * Usage: npm run manual-join-requests
 */

import 'dotenv/config';
import { connectToWhatsApp } from '../src/connection';
import { processAllGroupJoinRequests } from '../src/joinRequestProcessor';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  console.log('='.repeat(60));
  console.log(`[${new Date().toISOString()}] Manual Join Request Processing Started`);
  console.log('='.repeat(60));

  try {
    let socketInstance: any = null;

    await connectToWhatsApp((sock) => {
      socketInstance = sock;
    });

    // Wait a bit for connection to stabilize
    await new Promise(resolve => setTimeout(resolve, 5000));

    if (!socketInstance) {
      throw new Error('Failed to get socket connection');
    }

    console.log(`[${new Date().toISOString()}] Connection established, processing join requests...`);

    const results = await processAllGroupJoinRequests(socketInstance);

    // Create detailed report
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalGroups: results.length,
        totalApproved: results.reduce((sum, r) => sum + r.approved.length, 0),
        totalRejected: results.reduce((sum, r) => sum + r.rejected.length, 0),
        totalWaitlisted: results.reduce((sum, r) => sum + r.waitlisted.length, 0),
        totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
      },
      groupResults: results.map(r => ({
        groupName: r.groupName,
        approved: r.approved.length,
        rejected: r.rejected.length,
        waitlisted: r.waitlisted.length,
        errors: r.errors,
        details: {
          approvedJids: r.approved,
          rejectedJids: r.rejected,
          waitlistedJids: r.waitlisted,
        }
      }))
    };

    // Save report to file
    const reportsDir = path.join(__dirname, '..', 'reports', 'join-requests');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const reportFilename = `join-request-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const reportPath = path.join(reportsDir, reportFilename);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('PROCESSING COMPLETE - SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Groups Processed: ${report.summary.totalGroups}`);
    console.log(`✅ Total Approved: ${report.summary.totalApproved}`);
    console.log(`❌ Total Rejected (Bots): ${report.summary.totalRejected}`);
    console.log(`⏳ Total Waitlisted: ${report.summary.totalWaitlisted}`);
    console.log(`⚠️  Total Errors: ${report.summary.totalErrors}`);
    console.log('\nDetailed Results by Group:');
    console.log('-'.repeat(60));

    results.forEach(r => {
      if (r.approved.length > 0 || r.rejected.length > 0 || r.waitlisted.length > 0 || r.errors.length > 0) {
        console.log(`\n📱 ${r.groupName}`);
        if (r.approved.length > 0) {
          console.log(`   ✅ Approved: ${r.approved.length}`);
          r.approved.forEach(jid => {
            const phone = jid.replace('@s.whatsapp.net', '');
            console.log(`      - +${phone}`);
          });
        }
        if (r.rejected.length > 0) {
          console.log(`   ❌ Rejected: ${r.rejected.length}`);
          r.rejected.forEach(jid => {
            const phone = jid.replace('@s.whatsapp.net', '');
            console.log(`      - +${phone}`);
          });
        }
        if (r.waitlisted.length > 0) {
          console.log(`   ⏳ Waitlisted: ${r.waitlisted.length}`);
        }
        if (r.errors.length > 0) {
          console.log(`   ⚠️  Errors: ${r.errors.join(', ')}`);
        }
      }
    });

    console.log('\n' + '='.repeat(60));
    console.log(`Report saved to: ${reportPath}`);
    console.log('='.repeat(60));

    process.exit(0);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error:`, error);
    process.exit(1);
  }
}

main();
