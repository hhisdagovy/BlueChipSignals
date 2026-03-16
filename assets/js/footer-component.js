(function () {
    var placeholder = document.getElementById('footer-placeholder');
    if (!placeholder) return;

    var type = placeholder.getAttribute('data-footer-type') || 'standard-social';
    var base = placeholder.getAttribute('data-base') || '';

    var footer = document.createElement('footer');
    footer.innerHTML = buildFooter(type, base);
    placeholder.parentNode.replaceChild(footer, placeholder);

    function buildFooter(type, base) {
        var copy = buildCopy(type, base);
        var actions = buildActions();

        return '<div class="footer-shell">' + copy + actions + '</div>';
    }

    function buildCopy(type, base) {
        var parts = [
            '<span>&copy; 2026 Blue Chip Signals. All rights reserved.</span>',
            '<a href="' + base + 'legal">Terms &amp; Legal</a>'
        ];

        if (type === 'back-to-home') {
            parts.push('<a href="' + base + 'index">Back to Home</a>');
        }

        return '<div class="footer-copy">' +
            parts.join('<span class="footer-separator" aria-hidden="true">|</span>') +
        '</div>';
    }

    function buildActions() {
        var social = '<div class="footer-social">' +
            '<a href="https://www.tiktok.com/@bluechip.signals" target="_blank" aria-label="TikTok">' +
                '<i class="fab fa-tiktok"></i>' +
            '</a>' +
            '<a href="https://www.instagram.com/bluechip.signals/" target="_blank" aria-label="Instagram">' +
                '<i class="fab fa-instagram"></i>' +
            '</a>' +
            '<a href="https://x.com/BCSignalsHQ" target="_blank" aria-label="X">' +
                '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="width:1em;height:1em;display:inline-block;vertical-align:-0.125em;">' +
                    '<path fill="currentColor" d="M18.244 2.25h3.308L14.325 10.51 22.823 21.75h-6.653l-5.21-6.817-5.964 6.817H1.687l7.73-8.835L1.25 2.25h6.822l4.71 6.231zm-1.161 17.52h1.833L7.082 4.126H5.115z"></path>' +
                '</svg>' +
            '</a>' +
            '<a href="https://www.linkedin.com/company/blue-chip-signals" target="_blank" aria-label="LinkedIn">' +
                '<i class="fab fa-linkedin"></i>' +
            '</a>' +
        '</div>';
        var trust = '<div class="footer-trust">' +
            '<a class="footer-trust-link" href="https://www.trustpilot.com/review/bluechipsignals.online" target="_blank" rel="noopener" aria-label="Trustpilot reviews">' +
                '<span class="footer-trust-icon footer-trustpilot-icon" aria-hidden="true">' +
                    '<svg viewBox="0 0 24 24" focusable="false">' +
                        '<path fill="currentColor" d="M12 2.25l2.938 5.953 6.562.954-4.75 4.63 1.121 6.535L12 17.232l-5.871 3.09 1.121-6.535-4.75-4.63 6.562-.954L12 2.25z"></path>' +
                    '</svg>' +
                '</span>' +
                '<span>Trustpilot</span>' +
            '</a>' +
            '<div class="footer-badge">' +
                '<a href="https://saasbrowser.com/en/saas/1222483/blue-chip-signals" target="_blank" rel="noopener" aria-label="Found on SaaS Browser">' +
                    '<img src="https://static-files.saasbrowser.com/saas-browser-badge-16.svg" alt="Blue Chip Signals - SaaS Browser" width="156">' +
                '</a>' +
            '</div>' +
        '</div>';

        return '<div class="footer-actions">' + social + trust + '</div>';
    }
})();
