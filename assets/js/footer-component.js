(function () {
    var placeholder = document.getElementById('footer-placeholder');
    if (!placeholder) return;

    var type = placeholder.getAttribute('data-footer-type') || 'standard-social';
    var base = placeholder.getAttribute('data-base') || '';

    var footer = document.createElement('footer');
    footer.innerHTML = buildFooter(type, base);
    placeholder.parentNode.replaceChild(footer, placeholder);

    function buildFooter(type, base) {
        var termsLink = '<a href="' + base + 'legal.html">Terms &amp; Legal</a>';
        var homeLink  = '<a href="' + base + 'index.html">Back to Home</a>';

        var social = '<div class="social-media">' +
            '<a href="https://www.tiktok.com/@bluechip.signals" target="_blank" aria-label="TikTok">' +
                '<i class="fab fa-tiktok"></i>' +
            '</a>' +
            '<a href="https://www.instagram.com/bluechip.signals/" target="_blank" aria-label="Instagram">' +
                '<i class="fab fa-instagram"></i>' +
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
