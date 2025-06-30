// sr-calculator.js - Support & Resistance Level Calculator
(function(){
    const calculateBtn = document.getElementById('calculate-btn');
    const resultsDiv = document.getElementById('sr-results');
    
    if (!calculateBtn) return;

    calculateBtn.addEventListener('click', calculateLevels);

    function calculateLevels() {
        const high = parseFloat(document.getElementById('high-input').value);
        const low = parseFloat(document.getElementById('low-input').value);
        const close = parseFloat(document.getElementById('close-input').value);

        // Validate inputs
        if (isNaN(high) || isNaN(low) || isNaN(close)) {
            alert('Please enter valid numbers for all fields');
            return;
        }

        if (high < low) {
            alert('High must be greater than Low');
            return;
        }

        if (close < low || close > high) {
            alert('Close must be between High and Low');
            return;
        }

        // Calculate Pivot Point
        const pivot = (high + low + close) / 3;

        // Calculate Support Levels
        const s1 = (2 * pivot) - high;  // First support
        const s2 = pivot - (high - low); // Second support
        const s3 = low - 2 * (high - pivot); // Third support

        // Calculate Resistance Levels
        const r1 = (2 * pivot) - low;   // First resistance
        const r2 = pivot + (high - low); // Second resistance
        const r3 = high + 2 * (pivot - low); // Third resistance

        // Update the display
        document.getElementById('pivot-value').textContent = pivot.toFixed(2);
        document.getElementById('s1-value').textContent = s1.toFixed(2);
        document.getElementById('s2-value').textContent = s2.toFixed(2);
        document.getElementById('s3-value').textContent = s3.toFixed(2);
        document.getElementById('r1-value').textContent = r1.toFixed(2);
        document.getElementById('r2-value').textContent = r2.toFixed(2);
        document.getElementById('r3-value').textContent = r3.toFixed(2);

        // Show results
        resultsDiv.style.display = 'block';
        
        // Smooth scroll to results
        resultsDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Allow Enter key to trigger calculation
    document.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && (
            e.target.id === 'high-input' || 
            e.target.id === 'low-input' || 
            e.target.id === 'close-input'
        )) {
            calculateLevels();
        }
    });
})(); 