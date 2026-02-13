#!/usr/bin/env ts-node
/**
 * Debug script to check why admin detection is failing
 */

import 'dotenv/config';
import { connectToWhatsApp } from '../src/connection';
import { ALLOWED_GROUPS } from '../src/config';

async function main() {
  console.log('='.repeat(60));
  console.log('DEBUG: Checking Admin Status');
  console.log('='.repeat(60));

  let socketInstance: any = null;

  await connectToWhatsApp((sock) => {
    socketInstance = sock;
  });

  // Wait for connection to stabilize
  await new Promise(resolve => setTimeout(resolve, 5000));

  if (!socketInstance) {
    throw new Error('Failed to get socket connection');
  }

  const botJid = socketInstance.user?.id;
  console.log(`\nBot JID: ${botJid}`);
  console.log(`Bot LID: ${socketInstance.user?.lid || 'N/A'}\n`);

  const groups = ALLOWED_GROUPS.filter(g => g.id.endsWith('@g.us'));

  for (const group of groups) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Group: ${group.name}`);
    console.log(`Group ID: ${group.id}`);
    console.log('-'.repeat(60));

    try {
      const metadata = await socketInstance.groupMetadata(group.id);

      console.log(`\nTotal Participants: ${metadata.participants.length}`);
      console.log(`\nAdmins in group:`);

      const admins = metadata.participants.filter(
        (p: any) => p.admin === 'admin' || p.admin === 'superadmin'
      );

      admins.forEach((admin: any) => {
        console.log(`  - ${admin.id} (${admin.admin})`);
      });

      console.log(`\nBot JID to match: ${botJid}`);
      console.log(`\nChecking if bot is admin...`);

      const botParticipant = metadata.participants.find((p: any) => p.id === botJid);

      if (!botParticipant) {
        console.log(`❌ Bot NOT found in participants list!`);
        console.log(`\nAll participant JIDs (first 10):`);
        metadata.participants.slice(0, 10).forEach((p: any) => {
          console.log(`  - ${p.id}`);
        });
      } else {
        console.log(`✅ Bot found in participants`);
        console.log(`   Admin status: ${botParticipant.admin || 'none'}`);

        if (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin') {
          console.log(`✅ Bot IS ADMIN in this group!`);
        } else {
          console.log(`❌ Bot is NOT admin in this group`);
        }
      }

      // Small delay between groups
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`Error fetching metadata: ${error}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Debug complete');
  console.log('='.repeat(60));

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
