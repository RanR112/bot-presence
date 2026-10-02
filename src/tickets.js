import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { logger } from './logger.js';
import { SAWERIA_RUPIAH_PER_COIN } from './giftStore.js';
import { JsonStore } from './jsonStore.js';

export const IDS = {
  tiktokStart: 'verify:tiktok:start',
  tiktokModal: 'verify:tiktok:modal',
  saweriaStart: 'verify:saweria:start',
  saweriaModal: 'verify:saweria:modal',
  generalStart: 'ticket:general:start',
  approve: 'verify:approve',
  reject: 'verify:reject',
  close: 'ticket:close',
};

// Channel info komunitas -- tempat panduan "Cara Klaim History Coin" (lengkap
// dengan screenshot langkah-langkahnya) diposting, supaya panel & tiket cukup
// mengarahkan ke sana daripada mengulang instruksinya di sini.
export const INFO_CHANNEL_ID = '1554521502416773250';

export const TIKTOK_PANEL_TITLE = '🎁 Klaim Role Gift Leaderboard';
export const SAWERIA_PANEL_TITLE = '💙 Klaim Role Lewat Donasi Saweria';
export const GENERAL_PANEL_TITLE = '🎫 Butuh Bantuan?';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const formatRupiah = (value) => new Intl.NumberFormat('id-ID').format(value);

const isImage = (attachment) =>
  attachment.contentType?.startsWith('image/') || IMAGE_EXT.test(attachment.name ?? '');

export function buildTiktokPanel() {
  const embed = new EmbedBuilder()
    .setTitle(TIKTOK_PANEL_TITLE)
    .setColor(0x4a90d9)
    .setDescription(
      [
        'Sudah pernah kirim gift saat LIVE? Kamu bisa klaim role sesuai total coin yang sudah kamu kirim.',
        '',
        '**Cara klaim:**',
        '1. Klik tombol **Verifikasi Akun TikTok** di bawah.',
        '2. Isi nama dan username TikTok kamu.',
        '3. Kirim **screenshot bukti** kepemilikan akun di channel tiket yang otomatis dibuat.',
        '4. Tunggu moderator memverifikasi.',
        '',
        'Setelah disetujui, role akan diberikan otomatis sesuai total coin kamu, dan terus diperbarui saat kamu kirim gift lagi.',
        '',
        `**Punya riwayat gift dari sebelum bot ini aktif?** Bisa diklaim juga di channel tiket yang sama, lihat tata caranya di <#${INFO_CHANNEL_ID}>.`,
      ].join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.tiktokStart)
      .setLabel('Verifikasi Akun TikTok')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

export function buildSaweriaPanel() {
  const embed = new EmbedBuilder()
    .setTitle(SAWERIA_PANEL_TITLE)
    .setColor(0x4a90d9)
    .setDescription(
      [
        'Sudah pernah donasi lewat Saweria? Tautkan nama donaturmu supaya nilainya ikut dikonversi jadi coin (Rp' +
          SAWERIA_RUPIAH_PER_COIN +
          '/coin) dan masuk ke leaderboard & role milestone yang sama dengan gift TikTok.',
        '',
        '**Cara klaim:**',
        '1. Klik tombol **Verifikasi Donatur Saweria** di bawah.',
        '2. Isi nama donatur kamu **persis sama** seperti yang kamu pakai saat donasi di Saweria.',
        '3. Tunggu moderator meninjau (screenshot bukti donasi di channel tiket boleh dikirim, opsional, buat mempercepat).',
        '',
        '**Setelah ditautkan, donasi berikutnya otomatis terdeteksi dan langsung dikonversi** -- tidak perlu verifikasi ulang tiap donasi.',
      ].join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.saweriaStart)
      .setLabel('Verifikasi Donatur Saweria')
      .setEmoji('💙')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

export function buildGeneralPanel() {
  const embed = new EmbedBuilder()
    .setTitle(GENERAL_PANEL_TITLE)
    .setColor(0x5865f2)
    .setDescription(
      [
        'Ada pertanyaan, laporan, atau sesuatu yang mau disampaikan ke moderator di luar verifikasi TikTok/Saweria?',
        '',
        'Klik tombol di bawah buat buka channel privat antara kamu dan moderator.',
      ].join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.generalStart)
      .setLabel('Buat Tiket')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

export class TicketManager {
  #client;
  #store;
  #roles;
  #config;
  #tickets;

  constructor({ client, store, roles, config, filePath }) {
    this.#client = client;
    this.#store = store;
    this.#roles = roles;
    this.#config = config;
    this.#tickets = new JsonStore(filePath, { open: {} });
  }

  async load() {
    await this.#tickets.load();
    this.#tickets.get().open ??= {};
  }

  flush() {
    return this.#tickets.flush();
  }

  #all() {
    return this.#tickets.get().open;
  }

  #findOpenTicket(discordId, type) {
    return Object.entries(this.#all()).find(
      ([, ticket]) => ticket.discordId === discordId && ticket.type === type && !ticket.decidedAt && !ticket.closedAt,
    );
  }

  async handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId === IDS.tiktokStart) {
      return this.#openTiktokModal(interaction);
    }
    if (interaction.isButton() && interaction.customId === IDS.saweriaStart) {
      return this.#openSaweriaModal(interaction);
    }
    if (interaction.isButton() && interaction.customId === IDS.generalStart) {
      return this.#createGeneralTicket(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === IDS.tiktokModal) {
      return this.#createTiktokTicket(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === IDS.saweriaModal) {
      return this.#createSaweriaTicket(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith(`${IDS.approve}:`)) {
      return this.#decide(interaction, true);
    }
    if (interaction.isButton() && interaction.customId.startsWith(`${IDS.reject}:`)) {
      return this.#decide(interaction, false);
    }
    if (interaction.isButton() && interaction.customId.startsWith(`${IDS.close}:`)) {
      return this.#closeGeneralTicket(interaction);
    }
    return undefined;
  }

  async #openTiktokModal(interaction) {
    const existing = this.#store.linkForDiscordId(interaction.user.id);
    if (existing?.displayId) {
      await interaction.reply({
        content: `Akun TikTok kamu sudah terverifikasi sebagai **@${existing.displayId}**. Hubungi moderator kalau perlu diubah.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const openTicket = this.#findOpenTicket(interaction.user.id, 'tiktok');
    if (openTicket) {
      await interaction.reply({
        content: `Kamu masih punya tiket yang sedang diproses: <#${openTicket[0]}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder().setCustomId(IDS.tiktokModal).setTitle('Verifikasi Akun TikTok');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('realName')
          .setLabel('Nama kamu')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tiktokUsername')
          .setLabel('Username TikTok (tanpa @)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('historyCoin')
          .setLabel('Total coin histori (opsional)')
          .setPlaceholder('Kosongkan kalau tidak ada klaim histori')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(10)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('fanClubLevel')
          .setLabel('Level Fan Club saat ini (opsional)')
          .setPlaceholder('Kosongkan kalau tidak punya/tidak diklaim')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(5)
          .setRequired(false),
      ),
    );

    await interaction.showModal(modal);
  }

  async #createTiktokTicket(interaction) {
    const realName = interaction.fields.getTextInputValue('realName').trim();
    const displayId = interaction.fields
      .getTextInputValue('tiktokUsername')
      .trim()
      .replace(/^@/, '');

    // Dua field opsional -- diabaikan diam-diam kalau kosong atau bukan angka
    // positif, bukan menolak tiket. Moderator yang menilai kewajarannya nanti
    // dari screenshot, bukan validasi ketat di sini.
    const historyCoinRaw = interaction.fields.getTextInputValue('historyCoin').trim();
    const historyCoinClaim = /^\d+$/.test(historyCoinRaw)
      ? Number.parseInt(historyCoinRaw, 10)
      : null;
    const fanClubLevelRaw = interaction.fields.getTextInputValue('fanClubLevel').trim();
    const fanClubLevelClaim = /^\d+$/.test(fanClubLevelRaw)
      ? Number.parseInt(fanClubLevelRaw, 10)
      : null;

    if (!displayId) {
      await interaction.reply({
        content: 'Username TikTok tidak boleh kosong.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const taken = this.#store.linkForDisplayId(displayId);
    if (taken && taken.discordId !== interaction.user.id) {
      await interaction.reply({
        content: `Username **@${displayId}** sudah diklaim member lain. Hubungi moderator kalau ini keliru.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await this.#createTicketChannel(interaction, {
      name: `verif-tiktok-${interaction.user.username}`,
      reason: `Tiket verifikasi TikTok untuk ${interaction.user.tag}`,
    });

    this.#all()[channel.id] = {
      type: 'tiktok',
      discordId: interaction.user.id,
      realName,
      displayId,
      historyCoinClaim,
      fanClubLevelClaim,
      createdAt: new Date().toISOString(),
      screenshotUrl: null,
      submittedAt: null,
      decidedAt: null,
      decision: null,
      modId: null,
    };
    this.#tickets.scheduleSave();

    const claimLines = [];
    if (historyCoinClaim !== null) claimLines.push(`**Klaim coin histori:** ${historyCoinClaim}`);
    if (fanClubLevelClaim !== null)
      claimLines.push(`**Klaim Level Fan Club:** ${fanClubLevelClaim}`);

    const embed = new EmbedBuilder()
      .setTitle('🎫 Tiket Verifikasi TikTok')
      .setColor(0x5865f2)
      .setDescription(
        [
          `Halo <@${interaction.user.id}>, data kamu sudah tercatat:`,
          `**Nama:** ${realName}`,
          `**Username TikTok:** @${displayId}`,
          ...claimLines,
          '',
          '**Langkah terakhir (wajib):** kirim **screenshot bukti** kepemilikan akun TikTok tersebut di channel ini (misalnya tangkapan layar profil kamu saat sedang login). Ini yang memberi tahu moderator kalau tiket kamu siap direview.',
          '',
          historyCoinClaim !== null || fanClubLevelClaim !== null
            ? `**Untuk klaim coin histori dan/atau Level Fan Club yang kamu isi tadi (opsional):** sekalian kirim juga screenshot buktinya di channel ini (mis. Riwayat Koin TikTok untuk coin histori, tampilan badge Fan Club untuk level). Lihat tata cara lengkapnya di <#${INFO_CHANNEL_ID}>.`
            : `**Punya riwayat gift atau Level Fan Club yang mau diklaim?** Bisa sekalian di channel ini juga, lihat tata caranya di <#${INFO_CHANNEL_ID}>.`,
          '',
          'Setelah screenshot bukti akun TikTok terkirim, moderator akan otomatis diberi tahu.',
        ].join('\n'),
      );

    await channel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
    });
    await interaction.editReply({
      content: `Tiket kamu sudah dibuat: <#${channel.id}>`,
    });
  }

  async #openSaweriaModal(interaction) {
    const existing = this.#store.linkForDiscordId(interaction.user.id);
    if (existing?.saweriaDonorName) {
      await interaction.reply({
        content: `Nama donatur Saweria kamu sudah tertaut sebagai **${existing.saweriaDonorName}**. Hubungi moderator kalau perlu diubah.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const openTicket = this.#findOpenTicket(interaction.user.id, 'saweria');
    if (openTicket) {
      await interaction.reply({
        content: `Kamu masih punya tiket yang sedang diproses: <#${openTicket[0]}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder().setCustomId(IDS.saweriaModal).setTitle('Verifikasi Donatur Saweria');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('donorName')
          .setLabel('Nama donatur Saweria kamu')
          .setPlaceholder('Isi PERSIS sama seperti nama saat donasi di Saweria')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true),
      ),
    );

    await interaction.showModal(modal);
  }

  async #createSaweriaTicket(interaction) {
    const donorName = interaction.fields.getTextInputValue('donorName').trim();
    if (!donorName) {
      await interaction.reply({
        content: 'Nama donatur tidak boleh kosong.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const taken = this.#store.linkForSaweriaName(donorName);
    if (taken && taken.discordId !== interaction.user.id) {
      await interaction.reply({
        content: `Nama donatur **${donorName}** sudah ditautkan ke member lain. Hubungi moderator kalau ini keliru.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await this.#createTicketChannel(interaction, {
      name: `verif-saweria-${interaction.user.username}`,
      reason: `Tiket verifikasi Saweria untuk ${interaction.user.tag}`,
    });

    this.#all()[channel.id] = {
      type: 'saweria',
      discordId: interaction.user.id,
      donorName,
      createdAt: new Date().toISOString(),
      screenshotUrl: null,
      submittedAt: null,
      decidedAt: null,
      decision: null,
      modId: null,
    };
    this.#tickets.scheduleSave();

    const ledgerTotal = this.#store.saweriaLedgerTotal(donorName);

    const embed = new EmbedBuilder()
      .setTitle('🎫 Tiket Verifikasi Saweria')
      .setColor(0x5865f2)
      .setDescription(
        [
          `Halo <@${interaction.user.id}>, nama donatur yang kamu klaim: **${donorName}**`,
          '',
          ledgerTotal > 0
            ? `Bot sudah mencatat donasi dari nama ini (Rp${formatRupiah(ledgerTotal)}) -- begitu disetujui moderator, otomatis langsung dikonversi jadi coin.`
            : 'Bot belum mencatat donasi dari nama ini. Kalau kamu baru mau donasi, pastikan pakai nama PERSIS ini supaya otomatis kedeteksi ke depannya.',
          '',
          'Moderator sudah diberi tahu dan akan meninjau klaim ini. Kamu boleh (opsional) kirim screenshot bukti donasi di channel ini buat mempercepat peninjauan.',
        ].join('\n'),
      );

    await channel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
    });
    await interaction.editReply({
      content: `Tiket kamu sudah dibuat: <#${channel.id}>`,
    });

    // Beda dari TikTok: tidak nunggu screenshot buat kasih tahu moderator --
    // kita punya sumber independen (ledger webhook Saweria) buat cross-check.
    await this.#notifySaweriaModerators(channel.id, this.#all()[channel.id]);
  }

  async #createGeneralTicket(interaction) {
    const openTicket = this.#findOpenTicket(interaction.user.id, 'general');
    if (openTicket) {
      await interaction.reply({
        content: `Kamu masih punya tiket yang terbuka: <#${openTicket[0]}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = await this.#createTicketChannel(interaction, {
      name: `ticket-${interaction.user.username}`,
      reason: `Tiket umum untuk ${interaction.user.tag}`,
    });

    this.#all()[channel.id] = {
      type: 'general',
      discordId: interaction.user.id,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    this.#tickets.scheduleSave();

    const embed = new EmbedBuilder()
      .setTitle('🎫 Tiket Dibuka')
      .setColor(0x5865f2)
      .setDescription(
        `Halo <@${interaction.user.id}>, ceritakan apa yang ingin kamu sampaikan di sini. Moderator akan segera merespons.`,
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.close}:${channel.id}`)
        .setLabel('Tutup Tiket')
        .setStyle(ButtonStyle.Danger),
    );

    await channel.send({
      content: `<@&${this.#config.tickets.modRoleId}> <@${interaction.user.id}>`,
      embeds: [embed],
      components: [row],
    });
    await interaction.editReply({
      content: `Tiket kamu sudah dibuat: <#${channel.id}>`,
    });
  }

  /** Bikin channel tiket privat (overwrite permission member+mod standar) -- dipakai ketiga jenis tiket. */
  async #createTicketChannel(interaction, { name, reason }) {
    const guild = interaction.guild;
    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: this.#config.tickets.modRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ];

    return guild.channels.create({
      name: name.slice(0, 90),
      type: ChannelType.GuildText,
      parent: this.#config.tickets.categoryId ?? undefined,
      permissionOverwrites: overwrites,
      reason,
    });
  }

  /** Dipanggil untuk setiap pesan di guild; hanya pesan di channel tiket yang diproses. */
  async handleMessage(message) {
    const ticket = this.#all()[message.channelId];
    if (!ticket || ticket.decidedAt || ticket.closedAt) return;
    if (message.author.id !== ticket.discordId) return;
    if (ticket.type === 'general' || ticket.submittedAt) return;

    const screenshot = message.attachments.find(isImage);
    if (!screenshot) return;

    ticket.screenshotUrl = screenshot.url;
    ticket.submittedAt = new Date().toISOString();
    this.#tickets.scheduleSave();

    if (ticket.type === 'tiktok') {
      await message.reply('✅ Screenshot diterima. Moderator sudah diberi tahu, mohon tunggu.');
      await this.#notifyTiktokModerators(message.channelId, ticket);
    } else if (ticket.type === 'saweria') {
      // Moderator sudah diberi tahu dari awal (lihat #createSaweriaTicket) --
      // screenshot di sini murni bukti tambahan, tidak perlu notifikasi ulang.
      await message.reply('✅ Screenshot diterima sebagai bukti tambahan.');
    }
  }

  async #notifyTiktokModerators(channelId, ticket) {
    const channel = await this.#client.channels
      .fetch(this.#config.tickets.modNotifyChannelId)
      .catch(() => null);
    if (!channel?.isTextBased()) {
      logger.warn('Channel notifikasi moderator tidak ditemukan.');
      return;
    }

    const observed = this.#store.totalsForLink({ displayId: ticket.displayId });
    const fields = [
      { name: 'Member', value: `<@${ticket.discordId}>`, inline: true },
      { name: 'Nama', value: ticket.realName, inline: true },
      { name: 'Username TikTok', value: `@${ticket.displayId}`, inline: true },
      {
        name: 'Coin tercatat bot',
        value: observed.allTime > 0 ? `${observed.allTime}` : 'Belum ada data',
        inline: true,
      },
      { name: 'Tiket', value: `<#${channelId}>`, inline: true },
    ];
    if (ticket.historyCoinClaim !== null) {
      fields.push({
        name: 'Klaim coin histori',
        value: `${ticket.historyCoinClaim}`,
        inline: true,
      });
    }
    if (ticket.fanClubLevelClaim !== null) {
      fields.push({
        name: 'Klaim Level Fan Club',
        value: `${ticket.fanClubLevelClaim}`,
        inline: true,
      });
    }

    const footerParts = [];
    if (ticket.historyCoinClaim !== null) footerParts.push('>addcoin buat coin histori');
    if (ticket.fanClubLevelClaim !== null) footerParts.push('>setfanclublevel buat Fan Club');

    const embed = new EmbedBuilder()
      .setTitle('🔔 Permintaan Verifikasi TikTok Baru')
      .setColor(0xfaa61a)
      .addFields(fields)
      .setImage(ticket.screenshotUrl)
      .setFooter({
        text:
          footerParts.length > 0
            ? `Cek screenshot bukti tambahan di channel tiket, lalu pakai ${footerParts.join(' & ')} setelah menyetujui.`
            : 'Cek juga channel tiket -- kalau ada screenshot Riwayat Koin tambahan, pakai >addcoin setelah menyetujui.',
      })
      .setTimestamp(new Date());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.approve}:${channelId}`)
        .setLabel('Setujui')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDS.reject}:${channelId}`)
        .setLabel('Tolak')
        .setStyle(ButtonStyle.Danger),
    );

    await channel.send({
      content: `<@&${this.#config.tickets.modRoleId}>`,
      embeds: [embed],
      components: [row],
    });
  }

  async #notifySaweriaModerators(channelId, ticket) {
    const channel = await this.#client.channels
      .fetch(this.#config.tickets.modNotifyChannelId)
      .catch(() => null);
    if (!channel?.isTextBased()) {
      logger.warn('Channel notifikasi moderator tidak ditemukan.');
      return;
    }

    const ledgerTotal = this.#store.saweriaLedgerTotal(ticket.donorName);
    const fields = [
      { name: 'Member', value: `<@${ticket.discordId}>`, inline: true },
      { name: 'Nama donatur diklaim', value: ticket.donorName, inline: true },
      {
        name: 'Rupiah tercatat bot',
        value: ledgerTotal > 0 ? `Rp${formatRupiah(ledgerTotal)}` : 'Belum ada data',
        inline: true,
      },
      { name: 'Tiket', value: `<#${channelId}>`, inline: true },
    ];

    const embed = new EmbedBuilder()
      .setTitle('🔔 Permintaan Verifikasi Saweria Baru')
      .setColor(0xfaa61a)
      .addFields(fields)
      .setFooter({ text: 'Cek channel tiket buat screenshot bukti tambahan (opsional) sebelum memutuskan.' })
      .setTimestamp(new Date());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.approve}:${channelId}`)
        .setLabel('Setujui')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDS.reject}:${channelId}`)
        .setLabel('Tolak')
        .setStyle(ButtonStyle.Danger),
    );

    await channel.send({
      content: `<@&${this.#config.tickets.modRoleId}>`,
      embeds: [embed],
      components: [row],
    });
  }

  async #decide(interaction, approved) {
    const channelId = interaction.customId.split(':')[2];
    const ticket = this.#all()[channelId];

    if (!ticket) {
      await interaction.reply({
        content: 'Tiket ini sudah tidak ada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (ticket.decidedAt) {
      await interaction.reply({
        content: `Tiket ini sudah diputuskan (${ticket.decision}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.member.roles.cache.has(this.#config.tickets.modRoleId)) {
      await interaction.reply({
        content: 'Hanya moderator yang bisa memutuskan.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    ticket.decidedAt = new Date().toISOString();
    ticket.decision = approved ? 'approved' : 'rejected';
    ticket.modId = interaction.user.id;
    this.#tickets.scheduleSave();

    let description;
    if (approved && ticket.type === 'tiktok') {
      this.#store.createLink(ticket.discordId, {
        displayId: ticket.displayId,
        realName: ticket.realName,
      });
      const totals = this.#store.totalsForLink(this.#store.linkForDiscordId(ticket.discordId));
      const { granted, failed, memberNotFound } = await this.#roles.syncMilestones(
        ticket.discordId,
        totals.allTime,
      );
      let grantedText;
      if (granted.length > 0) {
        grantedText = `\nRole yang kamu dapat: ${granted.map((m) => `**${m.name}**`).join(', ')}`;
      } else if (memberNotFound || failed.length > 0) {
        grantedText =
          '\n⚠️ Ada milestone yang seharusnya didapat tapi role gagal diberikan -- moderator perlu cek log bot.';
        logger.error(
          `Gagal memberi role saat approve tiket ${ticket.discordId}: memberNotFound=${memberNotFound}, failed=${JSON.stringify(failed)}`,
        );
      } else {
        grantedText =
          '\nBelum ada role milestone yang tercapai. Kirim gift lagi saat LIVE untuk naik tingkat.';
      }
      description = `Akun **@${ticket.displayId}** berhasil ditautkan.${grantedText}`;
    } else if (approved && ticket.type === 'saweria') {
      const result = this.#store.linkSaweriaDonor(ticket.discordId, ticket.donorName);
      if (result.error === 'taken') {
        description = `⚠️ Nama **${ticket.donorName}** sudah keburu ditautkan ke member lain -- tidak jadi ditautkan. Moderator perlu cek manual.`;
      } else {
        let grantedText = '';
        if (result.credited && result.deltaCoins > 0) {
          const syncResult = await this.#roles.syncMilestones(ticket.discordId, result.newTotal);
          grantedText = `\n+${result.deltaCoins} coin dikreditkan dari histori donasi yang sudah terkumpul.`;
          if (syncResult.granted.length > 0) {
            grantedText += `\nRole: ${syncResult.granted.map((m) => `**${m.name}**`).join(', ')}`;
          }
        } else {
          grantedText = '\nBelum ada histori donasi tercatat dari nama ini -- otomatis kekredit begitu donasi masuk.';
        }
        description = `Nama donatur **${ticket.donorName}** berhasil ditautkan.${grantedText}`;
      }
    } else {
      description = 'Verifikasi kamu ditolak. Hubungi moderator kalau ingin mengajukan ulang.';
    }

    const ticketChannel = await this.#client.channels.fetch(channelId).catch(() => null);
    if (ticketChannel?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle(approved ? '✅ Verifikasi Disetujui' : '❌ Verifikasi Ditolak')
        .setColor(approved ? 0x57f287 : 0xed4245)
        .setDescription(description)
        .setFooter({
          text: `Tiket ditutup otomatis ${this.#config.tickets.closeAfterHours} jam lagi.`,
        });
      await ticketChannel.send({
        content: `<@${ticket.discordId}>`,
        embeds: [embed],
      });
    }

    await interaction.message
      .edit({
        components: [],
        content: `${approved ? '✅ Disetujui' : '❌ Ditolak'} oleh <@${interaction.user.id}>`,
      })
      .catch(() => {});
  }

  async #closeGeneralTicket(interaction) {
    const channelId = interaction.customId.split(':')[1];
    const ticket = this.#all()[channelId];

    if (!ticket) {
      await interaction.reply({
        content: 'Tiket ini sudah tidak ada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (ticket.closedAt) {
      await interaction.reply({
        content: 'Tiket ini sudah ditutup.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.member.roles.cache.has(this.#config.tickets.modRoleId)) {
      await interaction.reply({
        content: 'Hanya moderator yang bisa menutup tiket.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    ticket.closedAt = new Date().toISOString();
    this.#tickets.scheduleSave();

    await interaction.reply(
      `Tiket ditutup oleh <@${interaction.user.id}>. Channel ini akan dihapus otomatis ${this.#config.tickets.closeAfterHours} jam lagi.`,
    );
    await interaction.message.edit({ components: [] }).catch(() => {});
  }

  /** Menutup tiket yang sudah lewat batas waktu sejak diputuskan (tiktok/saweria) atau ditutup (general). */
  async sweep() {
    const cutoffMs = this.#config.tickets.closeAfterHours * 3600_000;
    const now = Date.now();

    for (const [channelId, ticket] of Object.entries(this.#all())) {
      const resolvedAt = ticket.decidedAt ?? ticket.closedAt;
      if (!resolvedAt) continue;
      if (now - Date.parse(resolvedAt) < cutoffMs) continue;

      const channel = await this.#client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        await channel
          .delete('Tiket selesai')
          .catch((error) => logger.error(`Gagal menutup tiket ${channelId}: ${error.message}`));
      }
      delete this.#all()[channelId];
      this.#tickets.scheduleSave();
    }
  }
}
