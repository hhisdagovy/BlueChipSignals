(function () {
    var placeholder = document.getElementById('footer-placeholder');
    if (!placeholder) return;

    var type = placeholder.getAttribute('data-footer-type') || 'standard-social';
    var base = placeholder.getAttribute('data-base') || '';

    var footer = document.createElement('footer');
    footer.innerHTML = buildFooter(type, base);
    placeholder.parentNode.replaceChild(footer, placeholder);

    function buildFooter(type, base) {
        var termsLink = '<a href="' + base + 'legal">Terms &amp; Legal</a>';
        var homeLink  = '<a href="' + base + 'index">Back to Home</a>';

        var social = '<div class="social-media">' +
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

        var copyright = '&copy; 2026 Blue Chip Signals. All rights reserved.';

        switch (type) {
            case 'back-to-home':
                return '<p>' + copyright + ' | ' + termsLink + ' | ' + homeLink + '</p>' + social;

            case 'minimal':
                return '<p>' + copyright + ' | ' + termsLink + '</p>';

            default: /* standard-social */
                return '<p>' + copyright + ' | ' + termsLink + '</p>' + social;
        }
    }
})();
